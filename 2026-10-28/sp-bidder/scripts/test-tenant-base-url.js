'use strict';

/**
 * White-label tenant routing (per-account base URL / origin / socket).
 *
 * SuperProcure ships the same product on a customer's own host - Rallis runs on
 * https://logistics.tatachemicals.com/api, where an extra `/api` precedes `/sp/...`.
 * These checks pin two things:
 *
 *   1. A tenant account reaches the TENANT host, with the prefix in the right place.
 *   2. An account that says nothing still reaches api.superprocure.com, byte-identically.
 *
 * (2) is the one that matters most. Every existing BRL account is in that class, this is
 * live-money code, and the dangerous failure is silent: a malformed base URL does not throw
 * at request time, it produces a relative URL whose fetch error _request's retry swallows
 * into status 0 - an account that looks "connected" and lists zero loads.
 *
 * The `null`-vs-`undefined` checks below are not pedantry. validateAccount normalises absent
 * optional fields to `null`, and a JS destructuring default fires ONLY on `undefined`, so
 * `String(null)` would yield the literal string 'null' and route every request to
 * `null/sp/loads/v4`. That is the exact defect this file exists to prevent regressing.
 */

const assert = require('assert');
const { RealSuperProcureAdapter, DEFAULT_API_BASE, DEFAULT_WEB_ORIGIN } = require('../src/platform/realAdapter');
const { SpSocket, DEFAULT_SOCKET_URL, DEFAULT_SOCKET_PATH } = require('../src/platform/spSocket');
const { validateAccount } = require('../src/auth/accounts');

let checks = 0;
const ok = (label) => { checks++; console.log('  ok  ' + label); };

const TENANT = {
  api: 'https://logistics.tatachemicals.com/api',
  web: 'https://logistics.tatachemicals.com',
  socketPath: '/api/socket.io',
};

/** Capture the URL of the next request without any network. */
function capturingAdapter(opts = {}) {
  const seen = [];
  const adapter = new RealSuperProcureAdapter({
    token: 'test-token',
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { status: 200, headers: { get: () => null }, text: async () => '{}' };
    },
    ...opts,
  });
  return { adapter, seen };
}

(async () => {
  // ---------- 1. SP main is unchanged when the account says nothing ----------
  {
    const { adapter, seen } = capturingAdapter();
    await adapter._get('/sp/base/getAvailableViews?isWeb=1');
    assert.strictEqual(seen[0].url, 'https://api.superprocure.com/sp/base/getAvailableViews?isWeb=1');
    ok('no tenant configured -> SP main URL is byte-identical to today');
  }
  {
    // the null path: what a persisted record without the field actually produces.
    const { adapter, seen } = capturingAdapter({ apiBaseUrl: null, webOrigin: null });
    await adapter._get('/sp/loads/v4');
    assert.strictEqual(seen[0].url, 'https://api.superprocure.com/sp/loads/v4');
    assert.ok(!seen[0].url.includes('null'), 'a null base URL must never reach the wire as the string "null"');
    ok('apiBaseUrl:null falls back to SP main (the String(null) trap stays shut)');
  }
  {
    const { adapter } = capturingAdapter({ apiBaseUrl: null, webOrigin: null });
    assert.strictEqual(adapter._headers().origin, DEFAULT_WEB_ORIGIN);
    assert.strictEqual(adapter._headers().referer, DEFAULT_WEB_ORIGIN + '/');
    assert.strictEqual(adapter._headers()['sec-fetch-site'], 'same-site');
    ok('SP main keeps app.superprocure.com origin/referer and sec-fetch-site:same-site');
  }

  // ---------- 2. A tenant account reaches the tenant, prefix included ----------
  {
    const { adapter, seen } = capturingAdapter({ apiBaseUrl: TENANT.api, webOrigin: TENANT.web });
    await adapter._get('/sp/loads/v4');
    assert.strictEqual(seen[0].url, 'https://logistics.tatachemicals.com/api/sp/loads/v4');
    ok('tenant account -> /api sits before /sp/, exactly once');
  }
  {
    // the bid write path builds its own URL; prove the prefix lands there too.
    const { adapter, seen } = capturingAdapter({ apiBaseUrl: TENANT.api });
    await adapter._post('/sp/bids/createV2?id=819997&carrier=132', { amount: 1 });
    assert.strictEqual(seen[0].url,
      'https://logistics.tatachemicals.com/api/sp/bids/createV2?id=819997&carrier=132');
    ok('tenant bid write targets the tenant host (the money path, not just reads)');
  }
  {
    const { adapter, seen } = capturingAdapter({ apiBaseUrl: TENANT.api + '/' });
    await adapter._get('/sp/loads/v4');
    assert.strictEqual(seen[0].url, 'https://logistics.tatachemicals.com/api/sp/loads/v4');
    ok('a trailing slash on apiBaseUrl does not produce a double slash');
  }
  {
    const { adapter } = capturingAdapter({ apiBaseUrl: TENANT.api, webOrigin: TENANT.web });
    const h = adapter._headers();
    assert.strictEqual(h.origin, TENANT.web);
    assert.strictEqual(h.referer, TENANT.web + '/');
    // app and API share one host on this tenant, so a real browser sends same-origin.
    assert.strictEqual(h['sec-fetch-site'], 'same-origin');
    ok('tenant headers carry the tenant origin and a truthful sec-fetch-site:same-origin');
  }
  {
    const { adapter } = capturingAdapter({ apiBaseUrl: 'not a url', webOrigin: TENANT.web });
    assert.strictEqual(adapter._headers()['sec-fetch-site'], 'same-site');
    ok('an unparseable base URL degrades sec-fetch-site to today value, never throws');
  }

  // ---------- 3. Socket: namespace-vs-path is the trap ----------
  {
    const s = new SpSocket({ token: 't', carrierId: 1 });
    assert.strictEqual(s.url, DEFAULT_SOCKET_URL);
    assert.strictEqual(s.path, DEFAULT_SOCKET_PATH);
    ok('SpSocket without tenant args keeps SP main url + default /socket.io/ path');
  }
  {
    const s = new SpSocket({ token: 't', carrierId: 1, url: TENANT.web, path: TENANT.socketPath });
    assert.strictEqual(s.url, TENANT.web);
    assert.strictEqual(s.path, '/api/socket.io');
    ok('SpSocket takes the tenant socket path (observed on the wire as /api/socket.io)');
  }
  {
    // The prefix must NOT ride in the socket URL - socket.io would read it as a namespace.
    const { adapter } = capturingAdapter({ apiBaseUrl: TENANT.api });
    assert.strictEqual(adapter._socketOrigin(), 'https://logistics.tatachemicals.com');
    assert.ok(!adapter._socketOrigin().endsWith('/api'),
      'socket origin must be scheme+host only, or socket.io treats /api as a namespace');
    ok('_socketOrigin strips the path prefix (the socket.io namespace trap stays shut)');
  }
  {
    const { adapter } = capturingAdapter();
    assert.strictEqual(adapter._socketOrigin(), DEFAULT_SOCKET_URL);
    ok('_socketOrigin defaults to SP main when no tenant is configured');
  }

  // ---------- 4. The account record must actually carry the fields ----------
  {
    const rec = validateAccount({
      accountId: 'rallis', tokenEnv: 'SP_TOKEN_RALLIS',
      apiBaseUrl: TENANT.api, webOrigin: TENANT.web,
      socketUrl: TENANT.web, socketPath: TENANT.socketPath,
      authBaseUrl: 'https://logistics-auth.tatachemicals.com',
    });
    // validateAccount rebuilds its output field-by-field and does NOT spread the input,
    // so a field missing from that whitelist is dropped in silence - and a dropped
    // apiBaseUrl would send a TENANT token to api.superprocure.com.
    assert.strictEqual(rec.apiBaseUrl, TENANT.api);
    assert.strictEqual(rec.webOrigin, TENANT.web);
    assert.strictEqual(rec.socketUrl, TENANT.web);
    assert.strictEqual(rec.socketPath, TENANT.socketPath);
    assert.strictEqual(rec.authBaseUrl, 'https://logistics-auth.tatachemicals.com');
    ok('validateAccount preserves all five tenant fields through its whitelist');
  }
  {
    const rec = validateAccount({ accountId: 'primary', tokenEnv: 'SP_TOKEN' });
    assert.strictEqual(rec.apiBaseUrl, null);
    assert.strictEqual(rec.socketPath, null);
    ok('an account with no tenant fields validates to nulls (not undefined-shaped drift)');
  }
  {
    // and those nulls must survive the trip through buildRealStack's `|| undefined`.
    const rec = validateAccount({ accountId: 'primary', tokenEnv: 'SP_TOKEN' });
    const { adapter, seen } = capturingAdapter({
      apiBaseUrl: rec.apiBaseUrl || undefined,
      webOrigin: rec.webOrigin || undefined,
    });
    await adapter._get('/sp/loads/v4');
    assert.strictEqual(seen[0].url, DEFAULT_API_BASE + '/sp/loads/v4');
    ok('end-to-end: a legacy record -> validateAccount -> adapter still hits SP main');
  }
  {
    assert.throws(() => validateAccount({
      accountId: 'bad', tokenEnv: 'SP_TOKEN_X', apiBaseUrl: 'ftp://nope',
    }), /must be https/, 'a non-https base URL must fail loudly at boot');
    ok('a non-https tenant URL is rejected with BAD_ACCOUNT');
  }
  {
    assert.throws(() => validateAccount({
      accountId: 'bad', tokenEnv: 'SP_TOKEN_X', apiBaseUrl: 'not-a-url',
    }), /not a valid absolute URL/);
    ok('an unparseable tenant URL is rejected with BAD_ACCOUNT');
  }
  {
    const rec = validateAccount({
      accountId: 'rallis', tokenEnv: 'SP_TOKEN_RALLIS', apiBaseUrl: TENANT.api + '///',
    });
    assert.strictEqual(rec.apiBaseUrl, TENANT.api);
    ok('validateAccount stores the base URL canonically (trailing slashes stripped)');
  }

  // Explicit completion sentinel: scripts/run-tests.js grades by EXIT CODE only, so a file
  // that returns early would be scored a silent zero-assertion pass without this line.
  console.log(`\n${checks}/${checks} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
