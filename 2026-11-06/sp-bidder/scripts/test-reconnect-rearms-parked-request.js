'use strict';
/**
 * A LOAD PARKED BECAUSE ITS ACCOUNT WAS RECONNECTING IS BID ONCE THE FRESH STACK IS LIVE (ruling 47).
 *
 * rebuildAccountStack tears the old stack down before it awaits the replacement's activation. A desk
 * capture resolved in that window finds no live stack, and the capture seam keeps the cost and parks
 * the row as 'stopped' / heldReason 'platform_stack_unavailable' (W1-5, 4ee8ec7), telling the desk
 * the price "will be used as soon as this portal can bid". Nothing re-arms it when the fresh stack
 * goes live, so the load sits out its auction unless an operator presses Re-arm.
 *
 * The functions under test are the real ones: rebuildAccountStack, teardownStack, stackForRequest,
 * requireStackForRequest and any other top-level server.js helper the rebuild reaches are extracted
 * from src/web/server.js as text and linked on demand, over real BidEngines, a real
 * PriceRequestStore and the real armFromRequest. Only the network half is stubbed: buildRealStack
 * (no adapter) and activateRealStack (a gate the test holds open, then the engine's own rehydrate).
 *
 *   node scripts/test-reconnect-rearms-parked-request.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files + reading server.js as text)
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const appConfig = require('../src/config');
const pr = require('../src/pricing/priceRequests');

const { PriceRequestStore, armFromRequest } = pr;

let seq = 0;
const CLEAN = [];
const tmp = () => {
  const f = path.join(os.tmpdir(), `reconnect-rearm-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  return f;
};
const ENGINES = [];
const cleanup = () => {
  for (const e of ENGINES) {
    try { for (const m of e.snapshot()) e.stop(m.auctionId); } catch (_) {}
    try { for (const r of e.scheduledSnapshot()) e.stop(r.auctionId); } catch (_) {}
  }
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
};

function scanTo(src, i, stopAt) {
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
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (stopAt === 'close' && depth === 0 && c === '}') return i + 1;
    } else if (stopAt === 'semi' && depth === 0 && c === ';') return i;
  }
  return -1;
}

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.js'), 'utf8');

// A top-level `function` / `async function` / `const X = <function>` in server.js, as an expression.
function extractTopLevel(name) {
  for (const decl of [`\nasync function ${name}(`, `\nfunction ${name}(`]) {
    const at = SERVER_SRC.indexOf(decl);
    if (at < 0) continue;
    const end = scanTo(SERVER_SRC, SERVER_SRC.indexOf('(', at), 'close');
    if (end < 0) return null;
    return `(${SERVER_SRC.slice(at + 1, end)})`;
  }
  const decl = `\nconst ${name} = `;
  const at = SERVER_SRC.indexOf(decl);
  if (at < 0) return null;
  const rhsAt = at + decl.length;
  const rhsHead = SERVER_SRC.slice(rhsAt, rhsAt + 200);
  if (!/^(async\s+)?(function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(rhsHead)) return null;
  const end = scanTo(SERVER_SRC, rhsAt, 'semi');
  return end < 0 ? null : `(${SERVER_SRC.slice(rhsAt, end)})`;
}

// The fix may land as a new top-level helper in server.js, so every name the extracted code reaches
// is resolved here at call time: provided fakes first, then server.js's own top-level functions.
function link(provided) {
  const cache = new Map();
  const scope = new Proxy({}, {
    has: (_, k) => typeof k === 'string' && (k in provided || !(k in globalThis)),
    get: (_, k) => {
      if (typeof k !== 'string') return undefined;
      if (k in provided) return provided[k];
      if (cache.has(k)) return cache.get(k);
      const expr = extractTopLevel(k);
      if (!expr) {
        throw new Error(`harness: server.js code reached '${k}', which this harness neither provides nor can extract`);
      }
      // eslint-disable-next-line no-new-func
      const fn = new Function('__scope', `with (__scope) { return ${expr}; }`)(scope);
      cache.set(k, fn);
      return fn;
    },
  });
  return scope;
}

const ENGINE_CONFIG = {
  openAtMs: 60_000, openJitterMs: 0, softOpenAtMs: 60_000, softOpenJitterMs: 0,
  cadenceJitterMs: 0, floorWindowMs: 2_500, finalizeDebounceMs: 3_000,
  pollFarMs: 30_000, pollMidMs: 5_000, pollHotMs: 200,
  farThresholdMs: 120_000, hotThresholdMs: 20_000, minInterFireMs: 0, startGraceMs: 0,
};

function mkStack(account, intentsFile) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: () => new Promise(() => {}),
    placeBid: async () => ({ ok: true, accepted: true, myRank: 1 }),
  };
  const scheduler = new DurableScheduler(intentsFile);
  const engine = new BidEngine(adapter, scheduler, {
    config: ENGINE_CONFIG, rand: () => 0,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    onEvent: () => {},
  });
  ENGINES.push(engine);
  return { account, tag: null, adapter: null, scheduler, engine, discovery: null,
    tokenExpiryTimer: null, scopeRefresher: null };
}

const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };

function harness({ activationFails = false } = {}) {
  const account = { accountId: 'acct-a', label: 'acct-a' };
  const intentsFile = tmp();
  const store = createStore({ backend: 'memory' });
  const requests = new PriceRequestStore({ store, marginsPct: [12.6, 7.2, 5], minMarginPct: 5,
    platformKey: appConfig.platformKey });
  const stacks = [mkStack(account, intentsFile)];
  const gate = deferred();
  const built = [];
  const noop = () => {};
  const quietLog = Object.assign(() => {}, { debug: noop, info: noop, warn: noop, error: noop });
  const notifier = new Proxy({}, { get: () => async () => null });
  const scope = link({
    stacks, requests, store, notifier, config: appConfig, REAL: true, require,
    platformOf: pr.platformOf, ownedBy: pr.ownedBy, armFromRequest,
    assertBiddingEnabled: pr.assertBiddingEnabled, effectiveCloseAt: pr.effectiveCloseAt,
    assertRealClose: pr.assertRealClose, isPlaceholderClose: pr.isPlaceholderClose,
    log: quietLog, baseLog: quietLog, pushEvent: noop, noteAuthDeadMark: noop,
    buildRealStack: (acct, tag) => {
      const s = mkStack(acct, intentsFile);
      s.tag = tag;
      built.push(s);
      return s;
    },
    activateRealStack: async (stack) => {
      await gate.p;
      if (activationFails) throw new Error('login refused (test)');
      return stack.engine.rehydrate();
    },
  });
  return { account, store, requests, stacks, gate, built, scope, old: stacks[0] };
}

let loadSeq = 0;
function mkLoad(account, closesInMs) {
  loadSeq += 1;
  return {
    id: String(25490000 + loadSeq), lane: { origin: 'MUMBAI', destination: 'DELHI' }, equipment: '32FT',
    units: 1, companyName: 'ACME', branchName: 'Bhiwandi', status: 'live',
    closesAt: Date.now() + closesInMs, account,
  };
}

const DESK = { cost: 48_250, marginsPct: [11.5, 8, 6.5], minMarginPct: 6 };

// The capture route's own sequence (server.js POST /price/:token): capture, arm through
// requireStackForRequest, and on PLATFORM_STACK_UNAVAILABLE keep the cost and park the row.
async function captureDuringReconnect(h, load) {
  const created = await h.requests.createForLoad(load, { deadlineAt: load.closesAt - 5 * 60_000 });
  const captured = await h.requests.capture(created.id, { cost: DESK.cost,
    marginOverride: { marginsPct: DESK.marginsPct, minMarginPct: DESK.minMarginPct } });
  let code = null;
  try { armFromRequest(h.scope.requireStackForRequest(captured).engine, captured, { requests: h.requests }); }
  catch (e) { code = e.code; }
  if (code !== 'PLATFORM_STACK_UNAVAILABLE') {
    throw new Error(`setup: a capture during the reconnect window should refuse with PLATFORM_STACK_UNAVAILABLE, got ${code}`);
  }
  await h.requests.holdUnbiddable(captured.id, 'platform_stack_unavailable');
  return captured.id;
}

const onEngine = (engine, loadId) => engine.snapshot().some((m) => String(m.auctionId) === loadId && !m.finalized)
  || engine.scheduledSnapshot().some((r) => String(r.auctionId) === loadId);

async function until(pred, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
}

const results = [];
async function check(n, label, fn) {
  try { await fn(); results.push({ n, ok: true }); console.log(`  ok  ${n}. ${label}`); }
  catch (e) {
    if (/^(setup|harness):/.test(e.message)) throw e;
    results.push({ n, ok: false, msg: e.message });
    console.log(`  FAIL ${n}. ${label}\n       ${e.message}`);
  }
}

(async () => {
  // One rebuild carries the re-armable row and three rows that must be left alone, so the re-armed
  // row is the barrier that proves the re-arm pass has run before the others are judged.
  const h = harness();
  const pRebuild = h.scope.rebuildAccountStack(h.account, h.old);
  assert.strictEqual(h.old.engine.discarded, true, 'setup: the old stack is torn down before activation');

  const liveId = await captureDuringReconnect(h, mkLoad(h.account, 20 * 60_000));
  const pastLoad = mkLoad(h.account, 20 * 60_000);
  const pastId = await captureDuringReconnect(h, pastLoad);
  const stoppedId = await captureDuringReconnect(h, mkLoad(h.account, 20 * 60_000));
  const otherId = await captureDuringReconnect(h, mkLoad(h.account, 20 * 60_000));

  // The reconnect takes minutes (OTP, login, socket, rehydrate); this load's close passed inside it.
  const pastDoc = await h.requests.getByToken(pastId);
  await h.store.patchDoc(pr.COLLECTION, pastId, { load: Object.assign({}, pastDoc.load, { closesAt: Date.now() - 60_000 }) });
  // An operator put it back on and then stopped it: an operator stop, no longer the reconnect parking.
  await h.requests.rearm(stoppedId);
  await h.requests.stop(stoppedId);
  // Parked for a reason a reconnect does not clear: the engine handed this load to the desk.
  await h.requests.rearm(otherId);
  await h.requests.holdUnbiddable(otherId, 'tick_fault_handoff');

  h.gate.resolve();
  const fresh = await pRebuild;
  assert.ok(fresh && fresh.engine && !fresh.engine.discarded && h.stacks.includes(fresh),
    'setup: the rebuild swapped a live fresh stack into stacks');
  const liveLoadId = (await h.requests.getByToken(liveId)).loadId;
  await until(async () => (await h.requests.getByToken(liveId)).status === 'armed'
    && onEngine(fresh.engine, liveLoadId), 1_500);
  await new Promise((r) => setTimeout(r, 150));

  await check(1, 'a row parked during the reconnect is armed on the fresh stack at the desk\'s cost and margins', async () => {
    const doc = await h.requests.getByToken(liveId);
    const intent = fresh.engine.scheduler.get(liveLoadId);
    assert.ok(doc.status === 'armed' && onEngine(fresh.engine, liveLoadId),
      'a request parked as platform_stack_unavailable while its account reconnected is still '
      + `'${doc.status}' (heldReason ${doc.heldReason}) with ${onEngine(fresh.engine, liveLoadId) ? 'a' : 'no'} `
      + 'monitor or wake on the fresh engine after the fresh stack went live: nothing re-arms it, so the '
      + 'load sits out an open auction until an operator presses Re-arm');
    assert.ok(!doc.heldReason, `an armed row must not keep the reconnect reason, got heldReason ${doc.heldReason}`);
    assert.ok(intent, 'the fresh engine holds no durable intent for the re-armed load');
    assert.strictEqual(intent.cost, DESK.cost, 'the re-arm must bid the cost the desk entered');
    assert.deepStrictEqual(intent.marginsPct, DESK.marginsPct, 'the re-arm must bid the margins the desk entered');
    assert.strictEqual(intent.minMarginPct, DESK.minMarginPct, 'the re-arm must keep the desk\'s minimum margin');
    assert.strictEqual(doc.price.cost, DESK.cost, 'the stored cost must survive the re-arm');
    assert.deepStrictEqual(doc.price.marginsPct, DESK.marginsPct, 'the stored margins must survive the re-arm');
    assert.ok(!onEngine(h.old.engine, liveLoadId), 'the re-arm must not land on the torn-down engine');
  });

  await check(2, 'a parked row whose close passed during the reconnect is not re-armed', async () => {
    const doc = await h.requests.getByToken(pastId);
    assert.notStrictEqual(doc.status, 'armed', 'a load whose close has passed was put back to armed');
    assert.ok(!onEngine(fresh.engine, doc.loadId), 'a load whose close has passed got a monitor or wake');
  });

  await check(3, 'a row an operator stopped in the meantime stays stopped', async () => {
    const doc = await h.requests.getByToken(stoppedId);
    assert.strictEqual(doc.status, 'stopped', `an operator-stopped row was moved to '${doc.status}'`);
    assert.ok(!doc.heldReason, `an operator stop must still read as one, got heldReason ${doc.heldReason}`);
    assert.ok(!onEngine(fresh.engine, doc.loadId), 'an operator-stopped load got a monitor or wake');
  });

  await check(4, 'control: a row parked for another reason (tick_fault_handoff) is not touched', async () => {
    const doc = await h.requests.getByToken(otherId);
    assert.strictEqual(doc.status, 'stopped', `a handed-off row was moved to '${doc.status}'`);
    assert.strictEqual(doc.heldReason, 'tick_fault_handoff', `its reason changed to ${doc.heldReason}`);
    assert.ok(!onEngine(fresh.engine, doc.loadId), 'a load handed to the desk got a monitor or wake');
  });

  const f = harness({ activationFails: true });
  const pFailed = f.scope.rebuildAccountStack(f.account, f.old);
  const failedId = await captureDuringReconnect(f, mkLoad(f.account, 20 * 60_000));
  f.gate.resolve();
  let rebuildErr = null;
  try { await pFailed; } catch (e) { rebuildErr = e; }
  assert.ok(rebuildErr && /login refused/.test(rebuildErr.message), 'setup: the failed activation propagates out of the rebuild');
  await new Promise((r) => setTimeout(r, 150));

  await check(5, 'a failed rebuild leaves the row parked with its reason and cost', async () => {
    const doc = await f.requests.getByToken(failedId);
    assert.strictEqual(doc.status, 'stopped', `with no live stack the row reads '${doc.status}'`);
    assert.strictEqual(doc.heldReason, 'platform_stack_unavailable',
      `with no live stack the row must still say why it is not bidding, got heldReason ${doc.heldReason}`);
    assert.strictEqual(doc.price && doc.price.cost, DESK.cost, 'the desk\'s cost must be kept');
    for (const s of [f.old, ...f.built]) {
      assert.ok(!onEngine(s.engine, doc.loadId), 'a load with no live stack got a monitor or wake on a dead engine');
    }
  });

  const failed = results.filter((r) => !r.ok);
  cleanup();
  if (failed.length) {
    console.error(`\nFAIL: ${failed.map((r) => r.n).join(', ')} of ${results.length} - ${failed[0].msg}`);
    process.exit(1);
  }
  console.log(`\n${results.length}/${results.length} checks passed`);
  process.exit(0);
})().catch((e) => {
  console.error('FAIL: ' + e.message);
  cleanup();
  process.exit(1);
});
