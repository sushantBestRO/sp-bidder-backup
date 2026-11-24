'use strict';

/**
 * Operator login primitives for the console gate. Built on Node's `crypto` only -
 * no auth dependency to vet or keep patched, and no plaintext secret anywhere.
 *
 *   password:  scrypt hash, format `scrypt$<saltHex>$<keyHex>`, constant-time verify.
 *   session:   stateless HMAC token `<payloadB64url>.<sigB64url>` with an exp claim.
 *              A fixed SP_SESSION_SECRET survives restarts; expiry bounds a leak.
 */

const crypto = require('crypto');
const { createLogger } = require('../logging/logger');

const log = createLogger('auth');

const KEYLEN = 32;
const SALTLEN = 16;

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const hmac = (secret, data) => crypto.createHmac('sha256', String(secret)).update(data).digest();

function hashPassword(password) {
  const salt = crypto.randomBytes(SALTLEN);
  const key = crypto.scryptSync(String(password), salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

// `username` is optional and used for logging only - it plays no part in the password
// check itself (the hash is verified independently of who claims to be logging in, so a
// wrong username and a wrong password take the same code path). Callers that don't pass
// it (existing call sites, and the hash-generation script) keep working unchanged; a
// caller that does pass it gets a login attempt recorded at info (success) or warn
// (failure) - never the password or the stored hash, only the username attempted.
function verifyPassword(password, stored, username) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (expected.length !== KEYLEN) return false;
  const got = crypto.scryptSync(String(password), salt, KEYLEN);
  const ok = crypto.timingSafeEqual(got, expected);
  if (username !== undefined) {
    if (ok) log.info('operator login succeeded', { user: username });
    else log.warn('operator login failed', { user: username });
  }
  return ok;
}

function signSession(user, secret, ttlMs) {
  const now = Date.now();
  const payload = b64url(Buffer.from(JSON.stringify({ u: user, iat: now, exp: now + ttlMs }), 'utf8'));
  return `${payload}.${b64url(hmac(secret, payload))}`;
}

// A missing token (no cookie sent at all) is the ordinary shape of an unauthenticated
// request - currentAdmin() runs on every /api/* call, so logging that branch would put a
// warn line on essentially every anonymous hit and drown out the cases worth seeing. Once
// a token IS present, though, every rejection below is either a tampered/truncated cookie
// or an expired session, and those are worth a warn line each - by reason, never by value,
// since the token itself is the credential and must never appear in a log line.
function verifySession(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) { log.warn('session verify failed', { reason: 'malformed' }); return null; }
  const payload = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(b64url(hmac(secret, payload)));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) {
    log.warn('session verify failed', { reason: 'bad_signature' });
    return null;
  }
  let claims;
  try { claims = JSON.parse(b64urlDecode(payload).toString('utf8')); } catch (_) {
    log.warn('session verify failed', { reason: 'malformed' });
    return null;
  }
  if (!claims || typeof claims.exp !== 'number' || Date.now() >= claims.exp) {
    log.warn('session verify failed', { reason: 'expired' });
    return null;
  }
  return claims;
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

const randomSecret = () => crypto.randomBytes(32).toString('hex');

module.exports = { hashPassword, verifyPassword, signSession, verifySession, readCookie, randomSecret };
