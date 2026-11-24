'use strict';
/**
 * Retention-window regression test. PRUNE_RETENTION_MS (src/pricing/priceRequests.js) is the
 * single source of "how many days of complete history" - both /api/history and
 * /api/export/summary are supposed to render their "Complete for the last ~N days" caveat off
 * it. The bug: the constant was defined (module scope) but never listed in that module's
 * module.exports, so server.js's `const { PRUNE_RETENTION_MS } = require(...)` silently
 * destructured undefined. Math.round(undefined / 86_400_000) is NaN, which JSON.stringify
 * serializes as retentionDays: null and interpolates into the literal string
 * "Complete for the last ~NaN days." on the live history page.
 *
 * Also pins /api/export/summary against the OTHER half of the same class: that endpoint
 * hardcoded a literal `retentionDays: 7` directly under a comment explicitly warning this is
 * the drift to avoid. Not a live bug today (7 === 7) but the same defect shape, so this test
 * asserts it derives from PRUNE_RETENTION_MS too and agrees with /api/history rather than
 * carrying its own copy that could silently drift the next time the retention window changes.
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
// exercise both endpoints with the login gate OFF (mock dev default); clear any ambient admin
// creds so the gate can't trip from the shell environment.
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const http = require('http');
const { PRUNE_RETENTION_MS } = require('../src/pricing/priceRequests');
const { app } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

function get(base, p) {
  return new Promise((resolve, reject) => {
    http.get(base + p, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, json });
      });
    }).on('error', reject);
  });
}

(async () => {
  // ---- 1. the constant itself must be exported ----
  ok(typeof PRUNE_RETENTION_MS === 'number' && Number.isFinite(PRUNE_RETENTION_MS),
    `PRUNE_RETENTION_MS is exported as a finite number (got ${PRUNE_RETENTION_MS})`);
  ok(PRUNE_RETENTION_MS === 7 * 86_400_000, `PRUNE_RETENTION_MS is 7 days in ms (got ${PRUNE_RETENTION_MS})`);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // ---- 2. /api/history derives window.retentionDays / window.note from the constant ----
  const hh = await get(base, '/api/history');
  ok(hh.status === 200, '/api/history returns 200');
  ok(hh.json && hh.json.window && hh.json.window.retentionDays === 7,
    `/api/history window.retentionDays is 7, not NaN/null (got ${JSON.stringify(hh.json && hh.json.window && hh.json.window.retentionDays)})`);
  ok(hh.json && hh.json.window && !/NaN/.test(hh.json.window.note),
    `/api/history window.note has no literal NaN (got ${JSON.stringify(hh.json && hh.json.window && hh.json.window.note)})`);
  ok(hh.json && hh.json.window && hh.json.window.note.includes('~7 days'),
    `/api/history window.note names the correct day count (got ${JSON.stringify(hh.json && hh.json.window && hh.json.window.note)})`);

  // ---- 3. /api/export/summary must derive the same value, never a hand-copied literal ----
  const es = await get(base, '/api/export/summary');
  ok(es.status === 200, '/api/export/summary returns 200');
  ok(es.json && es.json.window && es.json.window.retentionDays === 7,
    `/api/export/summary window.retentionDays is 7 (got ${JSON.stringify(es.json && es.json.window && es.json.window.retentionDays)})`);
  ok(es.json && es.json.window && !/NaN/.test(es.json.window.note),
    `/api/export/summary window.note has no literal NaN (got ${JSON.stringify(es.json && es.json.window && es.json.window.note)})`);
  ok(es.json && hh.json && es.json.window.retentionDays === hh.json.window.retentionDays,
    '/api/history and /api/export/summary agree on retentionDays (no drift between the derived value and the other endpoint\'s copy)');

  server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
