'use strict';
/**
 * Regression: realAdapter._request must bound every fetch with a timeout, so a hung socket
 * (TCP stall, no RST/response) can't wedge the caller forever. A hung bid WRITE otherwise
 * leaves the engine's bidInProgress stuck true and the monitor stops rescheduling - the bot
 * goes silent through the close and loses a winnable auction with no alert.
 *
 * Drives the REAL _request with an injected fetchImpl that never settles, at a short timeout,
 * and asserts: (1) _request returns status 0 (does not hang); (2) placeBid throws a NETWORK
 * error (so the engine's uncertain-submit catch clears bidInProgress + reads rank back). The
 * timeout is honored even though the fake fetch ignores the AbortController signal (Promise.race).
 *
 *   node scripts/test-request-timeout.js
 */
const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

(async () => {
  // a fetch that never settles AND ignores the abort signal (worst case)
  const neverSettles = () => new Promise(() => {});

  // 1. a read GET times out to status 0 rather than hanging (retry path still bounded)
  {
    const a = new RealSuperProcureAdapter({ token: 'FAKE.TEST.TOKEN', fetchImpl: neverSettles });
    const t0 = Date.now();
    const res = await a._request('GET', '/sp/base/ping', { retry: false, timeoutMs: 150 });
    const dt = Date.now() - t0;
    assert.strictEqual(res.status, 0, 'hung read settles to status 0');
    assert.ok(dt < 2000, `read returned promptly on timeout (took ${dt}ms)`);
    ok('hung read fetch is bounded by the timeout (status 0, no hang)');
  }

  // 2. a hung bid WRITE throws NETWORK (not a silent hang) so the engine can recover
  {
    const a = new RealSuperProcureAdapter({ token: 'FAKE.TEST.TOKEN', fetchImpl: neverSettles });
    a.writeEnabled = true;
    a.account = { carrierId: 2667 };
    a.ensureSession = async () => a.account; // skip the token-expiry check for the test
    let threw = null;
    const t0 = Date.now();
    try { await a.placeBid('22365292', 90000, {}); }
    catch (e) { threw = e; }
    const dt = Date.now() - t0;
    // placeBid uses a 2500ms write timeout internally; allow headroom
    assert.ok(threw, 'hung write threw instead of hanging');
    assert.strictEqual(threw.code, 'NETWORK', 'hung write throws a NETWORK error (engine reads rank back)');
    assert.ok(dt < 4000, `write threw within its timeout window (took ${dt}ms)`);
    ok('hung bid write throws NETWORK within its timeout (engine can recover, not frozen)');
  }

  console.log(`\n${pass}/2 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
