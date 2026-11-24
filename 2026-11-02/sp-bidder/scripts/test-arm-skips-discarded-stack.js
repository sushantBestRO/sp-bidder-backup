'use strict';
/**
 * A PRICED LOAD MUST NOT BE ARMED ONTO A TORN-DOWN STACK.
 *
 * rebuildAccountStack tears the old stack down (teardownStack -> engine.discard()) before it awaits
 * the replacement's activation, and only then swaps it in `stacks`; a failed activation leaves the
 * old stack there until restart. A desk capture, re-price or Re-arm resolved through
 * stackForRequest in that window arms the discarded engine: the intent persists as 'armed' and
 * _schedule refuses to plant a tick, so the load never bids and nothing says so.
 *
 * The functions under test are the real ones: stackForRequest, requireStackForRequest and
 * teardownStack are brace-matched out of src/web/server.js as text, over stacks holding real
 * BidEngines with real DurableSchedulers on temp files.
 *
 *   node scripts/test-arm-skips-discarded-stack.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files + reading server.js as text)
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { platformOf } = require('../src/pricing/priceRequests');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const CLEAN = [];
const tmp = () => {
  const f = path.join(os.tmpdir(), `arm-skips-discarded-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  return f;
};
const ENGINES = [];
const cleanup = () => {
  for (const e of ENGINES) { try { for (const m of e.snapshot()) e.stop(m.auctionId); } catch (_) {} }
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
};

function extractFunction(src, decl) {
  const start = src.indexOf(decl);
  if (start < 0) return null;
  let i = src.indexOf('{', start + decl.length - 1);
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

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.js'), 'utf8');
const pieces = {
  stackForRequest: extractFunction(SERVER_SRC, 'const stackForRequest = (reqDoc) => {'),
  requireStackForRequest: extractFunction(SERVER_SRC, 'function requireStackForRequest(reqDoc) {'),
  teardownStack: extractFunction(SERVER_SRC, 'function teardownStack(stack) {'),
};
for (const [k, v] of Object.entries(pieces)) assert.ok(v, `setup: could not find ${k} in src/web/server.js`);

// eslint-disable-next-line no-new-func
const bind = (stacks) => new Function('stacks', 'platformOf',
  `${pieces.stackForRequest};\n${pieces.requireStackForRequest};\n${pieces.teardownStack};\n`
  + 'return { stackForRequest, requireStackForRequest, teardownStack };')(stacks, platformOf);

function mkStack(accountId) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: () => new Promise(() => {}),
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
    onEvent: () => {},
  });
  ENGINES.push(engine);
  return { engine, discovery: null, adapter: null, account: { accountId, label: accountId },
    tokenExpiryTimer: null, scopeRefresher: null };
}

const reqFor = (accountId) => ({ loadId: '25480001', account: { accountId } });
const liveMeta = () => ({
  id: '25480001', lane: { origin: 'MUMBAI', destination: 'DELHI' }, equipment: '32FT', units: 1,
  companyName: 'ACME', branchName: 'Bhiwandi', closesAt: Date.now() + 1_200_000,
});
const INPUTS = { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] };

try {
  {
    const old = mkStack('acct-a');
    const stacks = [old];
    const fns = bind(stacks);
    fns.teardownStack(old);
    const resolved = fns.stackForRequest(reqFor('acct-a'));
    let armedTicks = null;
    if (resolved) {
      const m = resolved.engine.arm(liveMeta(), INPUTS);
      armedTicks = !!(m && m.timer);
    }
    assert.strictEqual(resolved, undefined,
      'a request for an account whose only stack was torn down still resolved to that stack; arming it '
      + `left a monitor that ${armedTicks ? 'ticks' : 'never ticks'} and an intent reading `
      + `'${resolved && resolved.engine.scheduler.get('25480001') && resolved.engine.scheduler.get('25480001').status}'`);
    let code = null;
    try { fns.requireStackForRequest(reqFor('acct-a')); } catch (e) { code = e.code; }
    assert.strictEqual(code, 'PLATFORM_STACK_UNAVAILABLE',
      `the arm entry point must refuse with PLATFORM_STACK_UNAVAILABLE (the code capture parks the row on), got ${code}`);
    ok('the torn-down stack is not an arm target: the arm entry point refuses with PLATFORM_STACK_UNAVAILABLE');
  }

  {
    const old = mkStack('acct-a');
    const sibling = mkStack('acct-b');
    const fns = bind([old, sibling]);
    fns.teardownStack(old);
    assert.throws(() => fns.requireStackForRequest(reqFor('acct-a')),
      (e) => e.code === 'PLATFORM_STACK_UNAVAILABLE',
      'a discarded owner must not hand a bid to a sibling account');
    assert.strictEqual(sibling.engine.monitors.size, 0);
    ok('a live sibling cannot take a discarded owner\'s bid');
  }

  {
    const own = mkStack('acct-a');
    const sibling = mkStack('acct-b');
    const fns = bind([sibling, own]);
    assert.strictEqual(fns.requireStackForRequest(reqFor('acct-a')), own,
      'control: a live owner stack must still be preferred over a sibling');
    ok('control: a live owner stack is still resolved first');
  }

  console.log(`\n${pass}/3 checks passed`);
  cleanup();
  process.exit(0);
} catch (e) {
  console.error('FAIL: ' + e.message);
  cleanup();
  process.exit(1);
}
