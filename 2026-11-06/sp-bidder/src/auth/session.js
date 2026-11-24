'use strict';

const { readJSON, writeJSONAtomic } = require('../store/atomicFile');
const { createLogger } = require('../logging/logger');

// Named 'session' rather than reusing adminAuth's 'auth' logger: this manages the
// SuperProcure PLATFORM's own session (token/cookie jar/device id from reauth), a
// different credential lifecycle from the operator console login gate in adminAuth.js,
// and keeping the two apart in pm2 logs makes it obvious which side a failure is on.
const log = createLogger('session');

/**
 * SessionManager — durable session + proactive, single-flight refresh.
 *
 * This is the production fix for the reference system's auth weakness (one
 * long-lived token in a JSON file, manual re-auth on a 401, which once left it
 * blind for 70 minutes). Pattern combines:
 *   - instagrapi:   persist the WHOLE session (token + cookie jar + device id)
 *                   and reuse the trusted device so a re-login usually SKIPS OTP.
 *   - google-auth:  parse expiry, refresh proactively at exp-minus-margin,
 *                   single-flight concurrent refreshes, retry a 401 exactly once.
 *
 * The REAL SuperProcure adapter will own a SessionManager and provide a
 * `reauth()` that performs the platform login (headless browser OTP capture, or
 * trusted-device token refresh). The demo's MockAdapter simulates this inline.
 *
 * `reauth()` must resolve to: { token, cookies?, expiresAt?, deviceId? }
 */
class SessionManager {
  constructor({ filePath, reauth, refreshMarginMs = 60_000, onEvent } = {}) {
    this.filePath = filePath;
    this.reauth = reauth; // async () => session
    this.refreshMarginMs = refreshMarginMs;
    this.onEvent = onEvent || (() => {});
    this.session = null;
    this._inflight = null; // single-flight guard
    this._load();
  }

  _load() {
    if (this.filePath) this.session = readJSON(this.filePath, null);
  }

  _persist() {
    if (!this.filePath || !this.session) return;
    writeJSONAtomic(this.filePath, this.session);
  }

  /** Parse a JWT's exp claim (seconds) into epoch ms, if present. */
  static jwtExpiryMs(token) {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
      return payload.exp ? payload.exp * 1000 : null;
    } catch (_) {
      // A session token that doesn't parse as a JWT isn't necessarily wrong - expiresAt on
      // the reauth result covers that case - but when neither is present this is the only
      // signal that expiry tracking silently fell back to the default window below, so it
      // is worth a warn line. Never log the token itself, only that parsing failed.
      log.warn('session token expiry could not be parsed', { reason: 'malformed' });
      return null;
    }
  }

  expiresAt() {
    if (!this.session) return 0;
    return this.session.expiresAt || SessionManager.jwtExpiryMs(this.session.token) || 0;
  }

  isExpiringSoon() {
    const exp = this.expiresAt();
    if (!exp) return !this.session; // no expiry info: refresh only if we have nothing
    return Date.now() >= exp - this.refreshMarginMs;
  }

  /** Returns a valid session, refreshing proactively. Concurrent calls share one refresh. */
  async get() {
    if (this.session && !this.isExpiringSoon()) return this.session;
    if (this._inflight) return this._inflight; // single-flight: dedupe concurrent refreshes
    this._inflight = (async () => {
      this.onEvent({ type: 'session_refresh_start', reason: this.session ? 'near_expiry' : 'no_session' });
      const fresh = await this.reauth();
      if (!fresh || !fresh.token) {
        log.warn('session refresh failed', { reason: 'reauth_returned_no_token' });
        throw new Error('reauth_failed');
      }
      if (!fresh.expiresAt) fresh.expiresAt = SessionManager.jwtExpiryMs(fresh.token) || (Date.now() + 30 * 60_000);
      this.session = fresh;
      this._persist();
      this.onEvent({ type: 'session_refresh_done', expiresAt: fresh.expiresAt });
      return fresh;
    })().finally(() => { this._inflight = null; });
    return this._inflight;
  }

  /** Call after a 401 to force exactly-one re-auth even if expiry looked fine. */
  async forceRefresh() {
    this.session = null;
    return this.get();
  }
}

module.exports = { SessionManager };
