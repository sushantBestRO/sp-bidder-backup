'use strict';
/**
 * A GOCOMET REFUSAL IS CLASSIFIED ON ITS WHOLE ALLOWLISTED TEXT, NOT ON THE DISPLAY CUT.
 *
 * Regression target: A070. projectSubmitError cut the allowlisted "why" at 300 characters, and the
 * adapter returned that same cut string as both `reason` and `raw` with nothing uncut beside it, so
 * the engine's classifiers only ever saw the first 300 characters. A body whose verdict sits past the
 * cut ("You've increased the quote price" after a long preamble) lost its class and the
 * upward-revision latch never engaged: the ladder walked down against a refusal that was never about
 * the price being too high.
 *
 * The display cut must stay: `reason` and `raw` are what reach closedBids.json, the bids jsonl and
 * pm2-err.log, and they stay bounded. Only classification reads the uncut projection.
 *
 * Mock policy: GoComet's transport is stubbed at fetchImpl, so the real adapter builds the envelope;
 * the engine is the real BidEngine with that envelope returned from its adapter seam.
 *
 *   node scripts/test-gocomet-reject-classify-uncut.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent file), not app state
const path = require('path');
const { GoCometAdapter, SUBMIT_ERROR_MAX_CHARS } = require('../src/platform/gocometAdapter');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

const tmpFiles = [];
process.on('exit', () => { for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch (_) {} } });
const tmp = () => { const f = path.join(os.tmpdir(), `gc-uncut-${process.pid}-${tmpFiles.length}.json`); tmpFiles.push(f); return f; };

const GC_RAISE = "You've increased the quote price. Please add a remark explaining the change to continue";

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const validToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' })}.sig`;
const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const FREIGHT = 'freight_charges_custom_charge_40ft';
const quoteDoc = () => ({
  id: 'Q1', updated_at: '2026-08-11T09:00:00Z', remarks: '',
  charges_list: { '11_freight_charges': { display_name: 'Freight', [FREIGHT]: { units: 1, unit_name: 'TRUCK', price: 100000 } } },
  total_charges: { total: { units: 1.0, quote_units: 1.0, unit_name: 'TRUCK', total: 100000.0 } },
});

async function gocometRejection(body) {
  const fetchImpl = async (url, init) => {
    if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quoteDoc()]);
    if (init.method === 'PUT') return resp(422, body);
    return resp(404, {});
  };
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const a = new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl, sleep: async () => {}, log: quiet });
  await a.login();
  return a.placeBid('ENQ-1', 41_420, { floor: 30_000 });
}

function mkEngine(envelope) {
  const attempted = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (_id, price) => { attempted.push(price); return Object.assign({}, envelope); },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 }, softClose: { enabled: false }, onEvent: () => {},
  });
  const m = eng.arm({ id: '260908LD2Z', lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1, equipment: '32ft',
    companyName: 'Havells', closesAt: Date.now() + 600_000 }, { cost: 30_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = [41_420, 40_736, 38_684];
  m.floor = 38_684;
  m.closeModel = 'soft'; m.extendCap = 5; m.extendsObserved = 0; m.revisionsLeft = 30; m.triggerWindowMs = 100_000;
  m.landedBids = 1;
  return { eng, m, attempted };
}

async function drive(eng, m) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    for (let r = 160_000, t = 0; r >= 0 && t < 20_000; t++) {
      await eng._maybeBid(m, { closesInMs: r, myRank: null, minDecrement: 100, standingL1Price: null, measuredRttMs: 50 });
      const step = Math.max(1, eng._cadence(r, m));
      r -= step; vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
}

(async () => {
  console.log('\n1. control: a short raise refusal latches the upward-revision class');
  {
    const env = await gocometRejection({ message: GC_RAISE });
    const { eng, m, attempted } = mkEngine(env);
    await drive(eng, m);
    ok(m.priceRaiseRefused === true, 'the short refusal latches');
    // Owner ruling 26 Sep (260925SQRC): a raise refusal is answered BELOW the standing quote (here the
    // refused price, since the quote read carries a higher one), never at or above it.
    ok(attempted.filter((p) => p >= 41_420).length === 1, `the refused price is never re-sent (sent ${attempted.join(', ')})`);
  }

  console.log('\n2. the same verdict past the 300-character display cut still latches');
  {
    const preamble = 'Quote validation notice. '.repeat(14);
    const env = await gocometRejection({ message: preamble + GC_RAISE });
    ok(preamble.length > SUBMIT_ERROR_MAX_CHARS, `the verdict sits past the cut (preamble ${preamble.length} chars)`);
    ok(typeof env.reason === 'string' && env.reason.length <= SUBMIT_ERROR_MAX_CHARS + 3,
      `reason stays bounded for the durable record and the log (${env.reason.length} chars)`);
    ok(typeof env.raw === 'string' && env.raw.length <= SUBMIT_ERROR_MAX_CHARS + 3,
      `raw stays bounded too (${env.raw.length} chars)`);
    const { eng, m, attempted } = mkEngine(env);
    await drive(eng, m);
    ok(m.priceRaiseRefused === true, `the long refusal latches the upward-revision class (priceRaiseRefused=${m.priceRaiseRefused})`);
    ok(attempted.filter((p) => p >= 41_420).length === 1, `the refused price is never re-sent in answer to "you may not raise" (sent ${attempted.join(', ')})`);
  }

  console.log('\n3. the uncut text carries only allowlisted fields');
  {
    const SENTINEL = 'SENTINEL-PWDIGEST-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const env = await gocometRejection({ message: 'x'.repeat(400) + GC_RAISE, created_by: { password_digest: SENTINEL } });
    ok(!JSON.stringify(env).includes(SENTINEL), 'no unallowlisted field appears anywhere on the envelope');
  }

  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
