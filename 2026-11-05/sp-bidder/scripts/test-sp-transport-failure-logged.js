'use strict';
/**
 * SUPERPROCURE: A WRITE THAT FAILS AT TRANSPORT SAYS WHY, ONCE, WITHOUT A RETRY.
 *
 * Regression target (latency map row 10): 52 of 2,368 SuperProcure writes in September (2.2%) came
 * back status 0, 39 of them well before the 2.5 s write timeout, and _request's catch discarded the
 * error, so nobody can tell a connection reset from a DNS failure from a timeout.
 *
 * Pinned (LOG_LEVEL=warn, console.error captured, fetchImpl injected):
 *   1. a fetch rejecting with a cause (ECONNRESET) is called once, returns status 0, and one warn line
 *      carries the error name, the cause code and the elapsed ms.
 *   2. the timeout path logs too: name Error, message request_timeout, no cause code.
 *   3. control: a write that gets a response logs no transport warning.
 *
 *   node scripts/test-sp-transport-failure-logged.js
 */
process.env.LOG_LEVEL = 'warn';

const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

const lines = [];
const realError = console.error;
console.error = (...a) => { lines.push(a.join(' ')); };
const records = () => lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
const transportRecords = () => records().filter((r) => r.level === 'warn' && /transport/i.test(r.msg || ''));

function adapter(fetchImpl) {
  return new RealSuperProcureAdapter({ token: 'x.eyJ1X2lkIjoxfQ.x', apiBaseUrl: 'http://127.0.0.1:9', authProbeEnabled: false,
    fetchImpl, sleep: async () => {} });
}

let pass = 0;
let fail = 0;
async function check(name, fn) {
  lines.length = 0;
  try { await fn(); pass++; realError('  ok  ' + name); }
  catch (e) { fail++; realError('  FAIL ' + name + ': ' + (e && e.message)); }
}

(async () => {
  await check('1. a reset write is called once, returns status 0 and logs its name, cause code and elapsed ms', async () => {
    let calls = 0;
    const a = adapter(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      const e = new TypeError('fetch failed');
      e.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      throw e;
    });
    const res = await a._request('POST', '/sp/bid/createV2', { body: { amount: 1 }, retry: false });
    assert.strictEqual(calls, 1, `the rejecting fetch was called ${calls} times`);
    assert.strictEqual(res.status, 0, `status ${res.status}`);
    const recs = transportRecords();
    assert.strictEqual(recs.length, 1, `${recs.length} transport warn lines: ${lines.join(' | ')}`);
    const r = recs[0];
    assert.strictEqual(r.errName, 'TypeError', `errName ${r.errName}`);
    assert.strictEqual(r.causeCode, 'ECONNRESET', `causeCode ${r.causeCode}`);
    assert.ok(Number.isFinite(r.elapsedMs) && r.elapsedMs >= 25, `elapsedMs ${r.elapsedMs}`);
    assert.strictEqual(r.method, 'POST');
  });

  await check('2. a timeout is logged too, with no cause code', async () => {
    let calls = 0;
    const a = adapter(() => { calls += 1; return new Promise((r) => setTimeout(r, 5_000)); });
    const res = await a._request('POST', '/sp/bid/createV2', { body: { amount: 1 }, retry: false, timeoutMs: 40 });
    assert.strictEqual(calls, 1, `the hung fetch was called ${calls} times`);
    assert.strictEqual(res.status, 0);
    const recs = transportRecords();
    assert.strictEqual(recs.length, 1, `${recs.length} transport warn lines`);
    assert.strictEqual(recs[0].errMessage, 'request_timeout', `errMessage ${recs[0].errMessage}`);
    assert.strictEqual(recs[0].causeCode, null, `causeCode ${recs[0].causeCode}`);
  });

  await check('3. control: a write that gets a response logs no transport warning', async () => {
    const a = adapter(async () => ({ status: 201, headers: { get: () => null }, text: async () => '{"data":{}}' }));
    const res = await a._request('POST', '/sp/bid/createV2', { body: { amount: 1 }, retry: false });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(transportRecords().length, 0, lines.join(' | '));
  });

  realError(`${pass} passed, ${fail} failed`);
  console.error = realError;
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, 3, `expected 3 checks, ran ${pass}`);
  process.exit(0);
})().catch((e) => { console.error = realError; console.error('FAIL test-sp-transport-failure-logged:', e && e.message); process.exit(1); });
