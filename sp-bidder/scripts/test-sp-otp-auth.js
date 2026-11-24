'use strict';

// spOtpAuth: the two-call SuperProcure OTP re-auth proxy, tested against a MOCK transport
// (no live SP). Pins the request shapes and the error/token handling the reconnect route relies on.

const assert = require('assert');
const { requestOtp, verifyOtp, extractToken } = require('../src/auth/spOtpAuth');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log('  ok  ' + m); };
const resp = (status, body) => ({ status, json: async () => body });

(async () => {
  // --- requestOtp -----------------------------------------------------------
  let cap = null;
  const okFetch = async (url, init) => { cap = { url, init }; return resp(200, { message: 'OTP sent', data: { id: '6a4f6eac661ac1bae18c61ea' } }); };
  const r1 = await requestOtp({ phone: '9594963428', fetchImpl: okFetch });
  ok(r1.sessionId === '6a4f6eac661ac1bae18c61ea', 'requestOtp returns data.id as sessionId');
  ok(/\/api\/v2\/auth\/phone$/.test(cap.url), 'requestOtp posts to /api/v2/auth/phone');
  ok(JSON.parse(cap.init.body).phone === '9594963428', 'requestOtp sends a digits-only phone');
  ok(JSON.parse(cap.init.body).countryCode === '+91', 'requestOtp defaults countryCode to +91');

  let threw = null;
  try { await requestOtp({ phone: '9594963428', fetchImpl: async () => resp(500, { message: 'boom' }) }); } catch (e) { threw = e.code; }
  ok(threw === 'OTP_START_FAILED', 'requestOtp throws OTP_START_FAILED on a non-200 / missing id');

  threw = null;
  try { await requestOtp({ phone: '9000000000', fetchImpl: async () => resp(404, { error: 'AUTH-001', message: 'Phone number not found.', data: null }) }); } catch (e) { threw = e.code; }
  ok(threw === 'PHONE_NOT_FOUND', 'requestOtp throws PHONE_NOT_FOUND on SP AUTH-001 / 404 (unregistered number)');

  // --- verifyOtp ------------------------------------------------------------
  let vcap = null;
  const vFetch = async (url, init) => { vcap = { url, init }; return resp(200, { error: null, message: 'ok', data: { token: 'Bearer  the-jwt ' } }); };
  const r2 = await verifyOtp({ sessionId: 'sid', otp: '123456', fetchImpl: vFetch });
  ok(r2.token === 'the-jwt', 'verifyOtp returns the token with Bearer stripped');
  ok(/\/api\/v1\/auth\/validate\/otp$/.test(vcap.url), 'verifyOtp posts to /api/v1/auth/validate/otp');
  const body = JSON.parse(vcap.init.body);
  ok(body.id === 'sid' && body.otp === '123456' && body.redirectUrl === 'https://app.superprocure.com'
    && body.selection === null && body.ssoLogin === '', 'verifyOtp sends the exact captured SP body shape');

  threw = null;
  try { await verifyOtp({ sessionId: 'sid', otp: '000000', fetchImpl: async () => resp(401, { error: 'AUTH-003', message: 'OTP is incorrect.', data: null }) }); } catch (e) { threw = e.code; }
  ok(threw === 'OTP_INCORRECT', 'verifyOtp throws OTP_INCORRECT on a bad code (SP 401 + {error})');

  // --- extractToken defensive shapes ---------------------------------------
  ok(extractToken({ data: { token: 't' } }) === 't', 'extractToken reads data.token');
  ok(extractToken({ data: 'raw-jwt' }) === 'raw-jwt', 'extractToken reads a bare-string data');
  ok(extractToken({ data: { authToken: 'a' } }) === 'a', 'extractToken falls back to data.authToken');
  ok(extractToken({ data: { user: { token: 'u' } } }) === 'u', 'extractToken finds a nested data.user.token');
  ok(extractToken({ data: null }) === null, 'extractToken returns null when absent');

  console.log(`\n${pass} passed, 0 failed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
