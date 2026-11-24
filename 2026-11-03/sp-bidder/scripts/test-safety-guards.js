'use strict';
/**
 * Regression for a cluster of safety hardening fixes:
 *   A. connectSocket() fails LOUD when the account has no carrierId (a branchIds-only login) -
 *      the socket matches our own bids by carrierId, so a null would run rank-tracking blind and
 *      the engine would dump the floor on loads it is already winning.
 *   B. the SnipeHarness restores the adapter's writeEnabled backstop after it finishes - it must
 *      not leave gate 2 permanently open on the shared adapter.
 *   C. the discovery allowlist matches on a word boundary, not a bare substring - a short token
 *      like "Ren" must not sweep in "Warren Steel", but must still match "Renewsys".
 *
 *   node scripts/test-safety-guards.js
 */
const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { SnipeHarness } = require('../src/engine/snipeHarness');
const { DiscoveryPoller } = require('../src/discovery/discovery');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

(async () => {
  // A. connectSocket refuses a null carrierId (fail loud, don't track rank blind)
  {
    const a = new RealSuperProcureAdapter({ token: 'FAKE.TEST.TOKEN' });
    a.account = { carrierId: null, branchIds: [42], userId: 'u1' }; // branchIds-only login
    await assert.rejects(() => a.connectSocket({}), /carrierId/,
      'connectSocket must refuse a null carrierId instead of tracking rank blind');
    ok('connectSocket fails loud on a null carrierId (no blind rank tracking)');
  }

  // B. the harness restores writeEnabled after it finishes
  {
    let placed = 0;
    const adapter = {
      writeEnabled: false,
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
      async placeBid() { placed++; return { accepted: true, status: 201, myRank: 1 }; },
    };
    // a fake sock the harness can watch/read without a network
    const sock = { watch() {}, state() { return { myRank: 1 }; }, closesInMs() { return 30000; } };
    const h = new SnipeHarness({ realAdapter: adapter, sock, log: () => {} });
    h.arm({ id: '1', lane: { origin: 'A', destination: 'B' }, revisionLimit: 3, softClose: false },
      { cost: 50000, maxMarginPct: 12, minMarginPct: 6, live: true });
    assert.strictEqual(adapter.writeEnabled, true, 'harness opens the backstop while live-arming');
    h.stop();
    assert.strictEqual(adapter.writeEnabled, false, 'harness restores writeEnabled=false after stop (backstop not left open)');
    ok('SnipeHarness restores the adapter write backstop after it finishes');
  }

  // C. allowlist word-boundary match
  {
    const poller = new DiscoveryPoller({ adapter: {}, requests: {}, notifier: {},
      config: { allowlist: { shippers: ['Ren'], lanes: [] } } });
    assert.strictEqual(poller.matchesAllowlist({ companyName: 'Renewsys India Pvt Ltd', lane: {} }), true,
      '"Ren" matches "Renewsys" (word prefix)');
    assert.strictEqual(poller.matchesAllowlist({ companyName: 'Warren Steel Logistics', lane: {} }), false,
      '"Ren" does NOT sweep in "Warren Steel" (mid-word)');
    const syn = new DiscoveryPoller({ adapter: {}, requests: {}, notifier: {},
      config: { allowlist: { shippers: ['Syngenta'], lanes: [] } } });
    assert.strictEqual(syn.matchesAllowlist({ companyName: 'Syngenta India Ltd', lane: {} }), true,
      'exact shipper still matches with trailing words');
    ok('allowlist matches on a word boundary, not a bare substring');
  }

  console.log(`\n${pass}/3 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
