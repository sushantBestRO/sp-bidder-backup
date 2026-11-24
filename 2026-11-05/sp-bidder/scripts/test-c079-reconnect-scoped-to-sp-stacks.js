'use strict';
/**
 * Pins C079 (fix/ops-alerting-divergences).
 *
 * tenantAuthFor and reconnect/verify's `existing` lookup both resolved an accountId across ALL
 * stacks combined - including the GoComet stack, which carries its own platformKey (every
 * SuperProcure stack carries none). An accountId of 'gocomet' colliding with the GoComet stack's
 * own accountId would let an SP OTP reconnect land a live SP bearer token into GoComet's tokenEnv
 * and tear its whole stack down. Both lookups now require `!s.platformKey`.
 *
 * Driven at module level (mock mode, no boot()) by pushing a fake GoComet-shaped stack directly
 * onto the exported `stacks` array - boot() is what normally builds it, and this is the one place
 * the divergence is actually reachable.
 *
 * @requires-summary-line
 *   node scripts/test-c079-reconnect-scoped-to-sp-stacks.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-c079-'));

const assert = require('assert');
const { stacks, tenantAuthFor } = require('../src/web/server');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

(async () => {
  // A GoComet-shaped stack whose accountId happens to collide with an id an operator might try to
  // reconnect ('gocomet') - platformKey is what the fix must key off, matching buildGoCometStack's
  // real shape exactly (stack.platformKey = gc.platformKey; no such field on an SP stack).
  // authBaseUrl set to a real-looking value so a wrongly-matched lookup is OBSERVABLE: tenantAuthFor
  // collapses an all-null tenant to plain `null` regardless of which stack it read, so an account
  // with every tenant field empty would pass this test whether the bug exists or not.
  const gocometLikeStack = {
    account: { accountId: 'gocomet', label: 'GoComet', tokenEnv: 'GC_TOKEN', carrierId: null, user: 'gc-user',
      authBaseUrl: 'https://gocomet-should-never-be-read.example' },
    platformKey: 'gocomet',
  };
  stacks.push(gocometLikeStack);
  const spStack = { account: { accountId: 'primary-test', label: 'Primary', authBaseUrl: 'https://x.example' } };
  try {
    // ---- tenantAuthFor must never resolve the GoComet stack for its own accountId ----
    const tenant = await tenantAuthFor('gocomet');
    assert.strictEqual(tenant, null,
      `C079: tenantAuthFor('gocomet') must not resolve the live GoComet stack (no persisted 'gocomet' SP account record exists) - got ${JSON.stringify(tenant)}`);
    ok('C079: tenantAuthFor searches SuperProcure stacks only, never the GoComet stack');

    // ---- an SP stack with a distinct accountId is still found normally (no over-correction) ----
    stacks.push(spStack);
    const spTenant = await tenantAuthFor('primary-test');
    assert.ok(spTenant && spTenant.authBaseUrl === 'https://x.example',
      `control: an SP stack (no platformKey) is still resolved normally: got ${JSON.stringify(spTenant)}`);
    ok('control: tenantAuthFor still resolves a genuine SP stack (the fix does not over-scope)');
  } finally {
    for (const s of [gocometLikeStack, spStack]) {
      const i = stacks.indexOf(s);
      if (i >= 0) stacks.splice(i, 1);
    }
  }

  console.log(`\n${pass}/2 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
