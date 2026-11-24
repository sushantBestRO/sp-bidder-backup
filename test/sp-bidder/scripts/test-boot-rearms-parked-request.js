'use strict';
/**
 * A LOAD PARKED BECAUSE ITS PORTAL HAD NO LIVE STACK IS BID ONCE A RESTART BRINGS ONE UP (ruling 47).
 *
 * The capture seam keeps the desk's cost and parks the row as 'stopped' / heldReason
 * 'platform_stack_unavailable', promising the price "will be used as soon as this portal can bid".
 * A parked row never wrote a durable intent, so boot's rehydrate cannot bring it back: after a restart
 * (a deploy, a crash, an account whose login failed at the last boot) the row stays parked while the
 * portal bids again. Owner default: the re-arm the reconnect uses also runs at boot, once every stack
 * boot will bring up (SuperProcure and GoComet) is live, and before the server takes requests.
 *
 *   1. boot() runs the parked-row re-arm after the last stack is live and before app.listen.
 *   2. The re-arm, over the restart shape (the rows persisted, a fresh engine with no intent for them),
 *      arms the parked row at the desk's cost and margins.
 *   3-5. It leaves alone a row whose close passed, an operator stop, and a row parked for another reason.
 *
 * The functions under test are the real ones, extracted from src/web/server.js as text and linked on
 * demand over a real BidEngine, a real PriceRequestStore and the real armFromRequest.
 *
 *   node scripts/test-boot-rearms-parked-request.js
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
  const f = path.join(os.tmpdir(), `boot-rearm-${process.pid}-${seq++}.json`);
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


const DESK = { cost: 48_250, marginsPct: [11.5, 8, 6.5], minMarginPct: 6 };
let loadSeq = 0;
function mkLoad(account, closesInMs) {
  loadSeq += 1;
  return {
    id: String(25590000 + loadSeq), lane: { origin: 'MUMBAI', destination: 'DELHI' }, equipment: '32FT',
    units: 1, companyName: 'ACME', branchName: 'Bhiwandi', status: 'live',
    closesAt: Date.now() + closesInMs, account,
  };
}

// What the capture seam leaves behind when no stack resolves the load: the cost kept, the row parked.
async function parkedByCapture(requests, load) {
  const created = await requests.createForLoad(load, { deadlineAt: load.closesAt - 5 * 60_000 });
  await requests.capture(created.id, { cost: DESK.cost,
    marginOverride: { marginsPct: DESK.marginsPct, minMarginPct: DESK.minMarginPct } });
  await requests.holdUnbiddable(created.id, 'platform_stack_unavailable');
  return created.id;
}

const onEngine = (engine, loadId) => engine.snapshot().some((m) => String(m.auctionId) === loadId && !m.finalized)
  || engine.scheduledSnapshot().some((r) => String(r.auctionId) === loadId);

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
  await check(1, 'boot() re-arms parked rows after every stack is live and before it takes requests', async () => {
    const boot = extractTopLevel('boot');
    if (!boot) throw new Error('harness: boot() was not found in server.js');
    const lastStack = boot.indexOf('rehydrateGoCometStack(attachGoCometStack())');
    const listen = boot.indexOf('app.listen(', lastStack);
    if (lastStack < 0 || listen < 0) throw new Error('harness: boot() no longer attaches the GoComet stack before app.listen');
    const rearm = boot.indexOf('rearmParkedRequests(', lastStack);
    assert.ok(rearm > lastStack && rearm < listen,
      'boot() brings every stack up and starts listening without re-arming the rows parked as '
      + 'platform_stack_unavailable: a parked row wrote no intent, so rehydrate cannot restore it, and after a '
      + 'restart it sits out an open auction until an operator presses Re-arm');
  });

  // The restart shape: rows parked by the previous process, persisted; a fresh engine with no intent.
  const account = { accountId: 'acct-a', label: 'acct-a' };
  const store = createStore({ backend: 'memory' });
  const requests = new PriceRequestStore({ store, marginsPct: [12.6, 7.2, 5], minMarginPct: 5,
    platformKey: appConfig.platformKey });
  const liveId = await parkedByCapture(requests, mkLoad(account, 20 * 60_000));
  const pastId = await parkedByCapture(requests, mkLoad(account, 20 * 60_000));
  const pastDoc = await requests.getByToken(pastId);
  await store.patchDoc(pr.COLLECTION, pastId, { load: Object.assign({}, pastDoc.load, { closesAt: Date.now() - 60_000 }) });
  const stoppedId = await parkedByCapture(requests, mkLoad(account, 20 * 60_000));
  await requests.rearm(stoppedId);
  await requests.stop(stoppedId);
  const otherId = await parkedByCapture(requests, mkLoad(account, 20 * 60_000));
  await requests.rearm(otherId);
  await requests.holdUnbiddable(otherId, 'tick_fault_handoff');

  const stack = mkStack(account, tmp());
  const noop = () => {};
  const quietLog = Object.assign(() => {}, { debug: noop, info: noop, warn: noop, error: noop, force: noop });
  const alerts = [];
  const notifier = new Proxy({}, { get: (_, k) => async (...a) => { if (k === 'alert') alerts.push(a); return null; } });
  const scope = link({
    stacks: [stack], requests, store, notifier, config: appConfig, REAL: true, require,
    platformOf: pr.platformOf, ownedBy: pr.ownedBy, armFromRequest,
    assertBiddingEnabled: pr.assertBiddingEnabled, effectiveCloseAt: pr.effectiveCloseAt,
    assertRealClose: pr.assertRealClose, isPlaceholderClose: pr.isPlaceholderClose,
    log: quietLog, baseLog: quietLog, pushEvent: noop,
  });
  const hasHelper = !!extractTopLevel('rearmParkedRequests');
  if (hasHelper) await scope.rearmParkedRequests();

  await check(2, 'the boot re-arm arms a row parked before the restart at the desk\'s cost and margins', async () => {
    const doc = await requests.getByToken(liveId);
    assert.ok(hasHelper, 'server.js has no parked-row re-arm for boot to run (rearmParkedRequests)');
    const intent = stack.engine.scheduler.get(doc.loadId);
    assert.ok(doc.status === 'armed' && onEngine(stack.engine, doc.loadId),
      `the parked row is '${doc.status}' (heldReason ${doc.heldReason}) with no monitor or wake after the re-arm`);
    assert.ok(!doc.heldReason, `an armed row must not keep the parking reason, got ${doc.heldReason}`);
    assert.ok(intent && intent.cost === DESK.cost, 'the re-arm must bid the cost the desk entered');
    assert.deepStrictEqual(intent.marginsPct, DESK.marginsPct, 'the re-arm must bid the margins the desk entered');
    assert.strictEqual(alerts.length, 0, `a clean re-arm raised ${alerts.length} alert(s)`);
  });

  await check(3, 'a parked row whose close passed is not re-armed', async () => {
    const doc = await requests.getByToken(pastId);
    assert.notStrictEqual(doc.status, 'armed', 'a load whose close has passed was put back to armed');
    assert.ok(!onEngine(stack.engine, doc.loadId), 'a load whose close has passed got a monitor or wake');
  });

  await check(4, 'an operator stop stays stopped', async () => {
    const doc = await requests.getByToken(stoppedId);
    assert.strictEqual(doc.status, 'stopped', `an operator-stopped row was moved to '${doc.status}'`);
    assert.ok(!doc.heldReason && !onEngine(stack.engine, doc.loadId), 'an operator-stopped load was touched');
  });

  await check(5, 'control: a row parked for another reason (tick_fault_handoff) is not touched', async () => {
    const doc = await requests.getByToken(otherId);
    assert.strictEqual(doc.heldReason, 'tick_fault_handoff', `its reason changed to ${doc.heldReason}`);
    assert.ok(doc.status === 'stopped' && !onEngine(stack.engine, doc.loadId), 'a load handed to the desk was touched');
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
