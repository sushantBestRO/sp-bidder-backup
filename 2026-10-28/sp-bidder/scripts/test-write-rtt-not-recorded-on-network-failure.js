'use strict';
/**
 * A failed PUT/write is recorded as the measured write RTT.
 *
 * Regression target: PR #154 review, Finding 2 (src/platform/gocometAdapter.js placeBid; the same
 * ordering also exists in src/platform/realAdapter.js placeBid).
 *
 * Both adapters set `this.lastWriteRttMs` from the elapsed span of the write call BEFORE checking
 * whether that call actually got a response (`res.status === 0` is the transport-failure/timeout
 * case). A timed-out write's ~timeout-length abort span therefore gets installed as the measured
 * write RTT for the rest of the process, even though placeBid then THROWS a NETWORK error for that
 * same call - a caller catching the throw still finds lastWriteRttMs mutated behind it.
 * lastWriteRttMs feeds the engine's snipe-timing compensation (`getAuctionState`'s `rtt`), so a
 * bogus multi-second value poisons the runway reserved for every later bid on that enquiry/load.
 *
 * WHAT MUST NOT MOVE: a successful write still records its RTT (checks 2 and 4) - the fix must only
 * skip the record on a genuine transport failure, never disable RTT tracking altogether.
 *
 *   node scripts/test-write-rtt-not-recorded-on-network-failure.js
 */
const assert = require('assert');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const validToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' })}.sig`;
const noSleep = async () => {};
function resp(status, body) { return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) }; }

// Single-line GoComet quote, valid TRUCK basis (mirrors basisQuote in test-gocomet-adapter.js).
const gcQuote = () => ({
  id: 'QB',
  charges_list: { '11_freight_charges': {
    freight_charges_custom_charge_40ft: { units: 2, unit_name: 'TRUCK', price: 1 },
  } },
  total_charges: { total: { units: 2.0, quote_units: 2.0, unit_name: 'TRUCK' } },
});

(async () => {
  // 1. MECHANISM (GoComet): the PUT never gets a response (status 0) -> placeBid throws NETWORK,
  //    and lastWriteRttMs must stay null (its initial value), not the failed call's own span.
  {
    const fetchImpl = async (url, init) => {
      if (init.method === 'GET' && String(url).includes('/quotes')) return resp(200, [gcQuote()]);
      if (init.method === 'PUT') throw new Error('ECONNRESET');
      return resp(404, {});
    };
    const a = new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl, sleep: noSleep });
    await a.login();
    let code = null;
    try { await a.placeBid('KB', 50000, { floor: 1000 }); } catch (e) { code = e.code; }
    assert.strictEqual(code, 'NETWORK', `expected the PUT failure to surface as NETWORK (got ${code})`);
    assert.strictEqual(a.lastWriteRttMs, null, 'a failed PUT must not be recorded as the write RTT');
    ok('GoComet: a network-failed PUT does not poison lastWriteRttMs');
  }

  // 2. CONTROL (GoComet): a successful PUT still records its RTT.
  {
    const fetchImpl = async (url, init) => {
      if (init.method === 'GET' && String(url).includes('/quotes')) return resp(200, [gcQuote()]);
      if (init.method === 'PUT' && String(url).includes('/submit')) return resp(200, { data: { quote_rank: 2 } });
      return resp(404, {});
    };
    const a = new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl, sleep: noSleep });
    await a.login();
    const r = await a.placeBid('KB', 50000, { floor: 1000 });
    assert.strictEqual(r.accepted, true, 'sanity: the bid was accepted');
    assert.strictEqual(typeof a.lastWriteRttMs, 'number', 'a successful PUT still records its RTT');
    ok('GoComet: a successful PUT still records lastWriteRttMs (control)');
  }

  // 3. MECHANISM (SuperProcure/realAdapter): the same ordering, same defect.
  {
    const fetchImpl = async () => { throw new Error('ECONNRESET'); };
    const a = new RealSuperProcureAdapter({ token: 't', fetchImpl });
    a.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000 };
    a.writeEnabled = true;
    let code = null;
    try { await a.placeBid('123', 1000, { floor: 999 }); } catch (e) { code = e.code; }
    assert.strictEqual(code, 'NETWORK', `expected the write failure to surface as NETWORK (got ${code})`);
    assert.strictEqual(a.lastWriteRttMs, null, 'a failed createV2 write must not be recorded as the write RTT');
    ok('realAdapter: a network-failed write does not poison lastWriteRttMs');
  }

  // 4. CONTROL (SuperProcure/realAdapter): a successful write still records its RTT.
  {
    const fetchImpl = async () => ({ status: 201, headers: { get: () => null }, json: async () => ({ data: { rank: 1 } }) });
    const a = new RealSuperProcureAdapter({ token: 't', fetchImpl });
    a.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000 };
    a.writeEnabled = true;
    const r = await a.placeBid('123', 1000, { floor: 999 });
    assert.strictEqual(r.accepted, true, 'sanity: the bid was accepted');
    assert.strictEqual(typeof a.lastWriteRttMs, 'number', 'a successful write still records lastWriteRttMs');
    ok('realAdapter: a successful write still records lastWriteRttMs (control)');
  }

  const EXPECTED = 4;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
