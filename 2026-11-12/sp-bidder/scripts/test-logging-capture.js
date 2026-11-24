'use strict';
/**
 * Regression: realAdapter must CAPTURE SuperProcure's plaintext rejection body instead
 * of collapsing it to null on the deployed money path.
 *
 * Incident (branch fix/logging-capture): SuperProcure answers a rejected live bid with
 * HTTP 400 and a PLAINTEXT body ("Load is under approval for allotment. Bidding is not
 * allowed."). The OLD _request did `await r.json().catch(() => null)`, which turned that
 * plaintext into null, so the only surviving record of the rejection was reason:'http_400'
 * - the server's real "why" was destroyed before any caller ever saw it. The fix reads the
 * body as TEXT first, then JSON.parse; _request returns { status, json, text, ... } and
 * placeBid surfaces the raw text in reason + raw, records carrierSent, and warns.
 * See the "the exact incident this fixes" comment in realAdapter.js:_request (text-first
 * read) and the carrier-identity note in realAdapter.js:placeBid (carrierSent capture).
 *
 * Stub-guard regression class: reading the body as text UNCONDITIONALLY would break fetch
 * stubs that implement only .json() (not .text()) - several tests in this suite stub json
 * only. The fix guards with `typeof r.text === 'function'` and falls back to r.json(). This
 * test LOCKS both the plaintext capture AND that guard, so reverting either (rawBody ->
 * always null, or dropping the guard) fails here.
 *
 * Tracker: branch fix/logging-capture; realAdapter.js:296-307 (text-first + guard),
 *          realAdapter.js:642-668 (reason/raw/carrierSent surfacing).
 *
 *   node scripts/test-logging-capture.js
 */
const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// the exact plaintext SuperProcure returns on a not-yet-allotted load (the incident body)
const REJECT_TEXT = 'Load is under approval for allotment. Bidding is not allowed.';
const CARRIER = 2667;

// Arrange helper: an adapter wired to one fetch stub, with a live-enough session so
// placeBid clears ensureSession() (far-future tokenExp) and the write gate.
function adapterWith(fetchImpl) {
  const a = new RealSuperProcureAdapter({ token: 't', fetchImpl });
  a.account = { carrierId: CARRIER, tokenExp: Date.now() + 3_600_000 };
  a.writeEnabled = true;
  return a;
}

// --- fetch stubs (mirror scripts/test-rate-limit.js fakeFetch shape) ---
// A real fetch Response exposes BOTH .text() and .json(); a rejection body is PLAINTEXT.
// Model it text-only: the fix reads .text(), JSON.parse fails, so json stays null - the
// exact path the plaintext capture must survive.
const plaintext400 = async () => ({ status: 400, headers: { get: () => null }, text: async () => REJECT_TEXT });
// JSON-ONLY stubs - NO .text key at all (the stub-guard case: fall back to .json()).
const jsonOnly400 = async () => ({ status: 400, headers: { get: () => null }, json: async () => ({ message: 'Insufficient revisions' }) });
const jsonOnly201 = async () => ({ status: 201, headers: { get: () => null }, json: async () => ({ data: { rank: 1 } }) });
// Accepted 201 whose TEXT body is a JSON string - proves text-then-parse still yields json.
const acceptedText201 = async () => ({ status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ data: { rank: 1 } }) });

(async () => {
  // 1. plaintext 400 body is captured into reason + text + raw (NOT collapsed to null)
  {
    // Arrange
    const a = adapterWith(plaintext400);
    // Act (direct _request seam first: the plaintext must ride .text with json left null)
    const rr = await a._request('GET', '/x');
    // Assert (seam)
    assert.strictEqual(rr.text, REJECT_TEXT, '_request carries the raw plaintext in .text');
    assert.strictEqual(rr.json, null, '_request leaves .json null when the body is not JSON');
    // Act (placeBid)
    const r = await a.placeBid('22365292', 90000, {});
    // Assert (placeBid surfaces the real message, not the bare status code)
    assert.strictEqual(r.accepted, false, 'plaintext 400 is a rejection');
    assert.strictEqual(r.status, 400, 'status surfaced');
    assert.strictEqual(r.text, REJECT_TEXT, 'raw plaintext body captured in r.text (not null)');
    assert.strictEqual(r.reason, REJECT_TEXT, "reason is SP's real message, not 'http_400'");
    assert.notStrictEqual(r.reason, 'http_400', 'reason is not the bare status code');
    assert.strictEqual(r.raw, REJECT_TEXT, 'raw carries the plaintext body (not silently null)');
    ok('plaintext 400 captured into reason + text + raw (not collapsed to null)');
  }

  // 2. carrierSent records the carrier id actually sent (carrier-identity diagnosis field)
  {
    // Arrange
    const a = adapterWith(plaintext400);
    // Act
    const r = await a.placeBid('22365292', 90000, {});
    // Assert
    assert.strictEqual(r.carrierSent, CARRIER, 'carrierSent === account.carrierId (2667)');
    ok('carrierSent recorded on a rejection');
  }

  // 3. json-only 400 stub (NO .text) survives the typeof r.text guard - reject path
  {
    // Arrange
    const a = adapterWith(jsonOnly400);
    // Act
    let r, threw = null;
    try { r = await a.placeBid('22365292', 90000, {}); } catch (e) { threw = e; }
    // Assert (must NOT throw: guard falls back to r.json())
    assert.strictEqual(threw, null, 'json-only stub must NOT throw (guard falls back to .json())');
    assert.strictEqual(r.accepted, false, 'json-only 400 is a rejection');
    assert.strictEqual(r.status, 400, 'status surfaced from json-only stub');
    assert.strictEqual(r.reason, 'Insufficient revisions', 'reason parsed from json.message via the .json() fallback');
    ok('json-only 400 stub survives the guard (reject path)');
  }

  // 4. json-only 201 stub (NO .text) survives the guard - accepted path, rank parsed
  {
    // Arrange
    const a = adapterWith(jsonOnly201);
    // Act
    const r = await a.placeBid('22365292', 90000, {});
    // Assert
    assert.strictEqual(r.accepted, true, 'json-only 201 accepted');
    assert.strictEqual(r.myRank, 1, 'myRank parsed from json.data.rank via the fallback');
    ok('json-only 201 stub survives the guard (accepted path)');
  }

  // 5. accepted-with-text 201: text-first still parses JSON on the happy path
  {
    // Arrange
    const a = adapterWith(acceptedText201);
    // Act
    const r = await a.placeBid('22365292', 90000, {});
    // Assert
    assert.strictEqual(r.accepted, true, 'text-body 201 accepted');
    assert.strictEqual(r.myRank, 1, 'text read then JSON.parse still yields rank on the happy path');
    ok('accepted-with-text 201: text-first still parses JSON (rank read)');
  }

  console.log(`\n${pass}/5 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
