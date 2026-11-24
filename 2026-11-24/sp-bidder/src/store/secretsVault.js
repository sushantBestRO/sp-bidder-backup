'use strict';

const path = require('path');
const fs = require('fs'); // src/store/ is the ONE allowed home of fs (the grep gate exempts it)
const { readJSON, writeJSONAtomic } = require('./atomicFile');

/**
 * SecretsVault - a chmod-600 on-box store for reconnect-minted SuperProcure tokens,
 * keyed by the env-var NAME an account references (tokenEnv -> token value). Lives in
 * src/store/ (the only place allowed to touch fs) and writes atomically via atomicFile.
 *
 * Why it exists: self-serve reconnect (phone -> OTP) mints a fresh token at RUNTIME.
 * The .env is the bootstrap default and is only read at process start; a runtime token
 * has to survive a restart without a human editing the .env. So the vault is the durable
 * source of truth for reconnect-updated tokens.
 *
 * Precedence: applyToEnv() OVERLAYS process.env at boot - the vault WINS over .env - so
 * token resolution (auth/accounts.js resolveAccountToken, auth/token.js resolveToken)
 * stays byte-for-byte unchanged: it reads process.env as always and transparently gets
 * the latest token. The .env still seeds the very first token (empty vault).
 *
 * The token is never written to an account record (that invariant is enforced by the
 * JWT canary in auth/accounts.js). Same secret posture as the .env: plaintext, chmod 600,
 * gitignored, on-box - not the reference bot's committed-plaintext sin.
 */

const VAULT_FILE = 'secrets.json'; // under dataDir; gitignored via data/*.json (+ explicit line)

const clean = (t) => String(t == null ? '' : t).replace(/^Bearer\s+/i, '').trim();

class SecretsVault {
  constructor({ dataDir }) {
    this.path = path.join(dataDir, VAULT_FILE);
    this._cache = null;
  }

  _load() {
    if (this._cache) return this._cache;
    this._cache = readJSON(this.path, {}) || {};
    return this._cache;
  }

  /** The stored token for an env-var name, or null. */
  get(tokenEnv) {
    const v = clean(this._load()[tokenEnv]);
    return v || null;
  }

  /** Persist a token under its env-var name (atomic + chmod 600) and cache it. */
  set(tokenEnv, token) {
    const value = clean(token);
    if (!value) { const e = new Error('refusing to store an empty token'); e.code = 'BAD_TOKEN'; throw e; }
    const cur = Object.assign({}, this._load());
    cur[tokenEnv] = value;
    writeJSONAtomic(this.path, cur);
    this._chmod600();
    this._cache = cur;
    return value;
  }

  _chmod600() {
    // POSIX only; the VPS is Ubuntu. Windows dev has no equivalent mode - skip silently.
    try { if (process.platform !== 'win32') fs.chmodSync(this.path, 0o600); } catch (_) {}
  }

  /**
   * Overlay every stored token onto process.env (vault wins over .env). Call ONCE at
   * startup, after dotenv has loaded the .env. Returns how many keys were applied.
   * `onKey`, if given, is called once per applied key so the caller can log which env
   * vars a runtime-minted token silently overrode - the return count alone doesn't say.
   */
  applyToEnv(env = process.env, { onKey } = {}) {
    const all = this._load();
    let n = 0;
    for (const [k, v] of Object.entries(all)) {
      const value = clean(v);
      if (value) {
        env[k] = value;
        n += 1;
        if (typeof onKey === 'function') { try { onKey(k); } catch (_) {} }
      }
    }
    return n;
  }
}

module.exports = { SecretsVault, VAULT_FILE };
