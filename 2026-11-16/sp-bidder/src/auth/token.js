'use strict';

/**
 * Resolve the SuperProcure bearer token for real mode from the ENVIRONMENT.
 *   Production: SP_TOKEN lives in a chmod-600 .env on the VPS (never git, never logged).
 *   Local dev:  export SP_TOKEN before starting real mode.
 *
 * Deliberately no filesystem access here: the store seam owns all file I/O (the
 * no-fs-outside-store guard in test-store.js), and reading a token from a chmod-600
 * .env is the production deploy model anyway. The recon/snipe scripts in scripts/
 * read a cookie export directly for local convenience - that layer is not gated.
 */
function resolveToken() {
  const t = process.env.SP_TOKEN;
  if (t && t.trim()) return t.replace(/^Bearer\s+/i, '').trim();
  throw new Error('no SuperProcure token: set SP_TOKEN (chmod-600 .env in prod; export it locally for real mode)');
}

module.exports = { resolveToken };
