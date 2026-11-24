'use strict';
/**
 * GOCOMET: EVERY LIVE READ SAYS AT DEBUG WHETHER ITS CLOSE WAS SNAPPED TO THE WHOLE SECOND.
 *
 * Regression target (latency map open question 3): the buzzer's 1 s countdown quantum can only go if
 * production reads actually take the snap path (an integer bid_closing_in and a parseable
 * current_server_time). Nothing recorded which path ran.
 *
 * Pinned (injected log and fetch, fixed clock):
 *   1. integer bid_closing_in with a server stamp: one debug line, snapped true.
 *   2. fractional bid_closing_in: snapped false.
 *   3. no current_server_time: snapped false.
 *   4. control: the close itself is unchanged by the logging (snapped read lands on a whole second).
 *
 *   node scripts/test-gocomet-snap-debug-line.js
 */
process.env.LOG_LEVEL = 'silent';

const assert = require('assert');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const token = `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400,
  user_id: 'u1', client_id: 'c1', token_type: 'vendor' })}.sig`;

async function readWith(data) {
  const debug = [];
  const log = { debug: (msg, meta) => debug.push({ msg, meta }), info() {}, warn() {}, error() {} };
  const base = Date.parse('2026-09-26T10:40:21.551Z');
  const fetchImpl = async (url) => ({ status: url.includes('/bidding-data') ? 200 : 404, headers: { get: () => null },
    text: async () => JSON.stringify(url.includes('/bidding-data') ? { data } : {}) });
  const a = new GoCometAdapter({ token, fetchImpl, sleep: async () => {}, now: () => base, log });
  await a.login();
  const s = await a.getAuctionState('K1');
  const lines = debug.filter((d) => d.meta && Object.prototype.hasOwnProperty.call(d.meta, 'snapped'));
  return { s, lines, base };
}

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message)); }
}

const STAMP = '2026-09-26T16:10:21.551+05:30';

(async () => {
  await check('1. an integer countdown with a server stamp logs snapped true', async () => {
    const { lines } = await readWith({ bid_closing_in: 600, vendor_rank: 2, revisions_left: 3, total_revisions: 0,
      current_server_time: STAMP });
    assert.strictEqual(lines.length, 1, `${lines.length} snap debug lines`);
    assert.strictEqual(lines[0].meta.snapped, true, JSON.stringify(lines[0].meta));
    assert.strictEqual(lines[0].meta.enquiry, 'K1');
  });

  await check('2. a fractional countdown logs snapped false', async () => {
    const { lines } = await readWith({ bid_closing_in: 600.4, vendor_rank: 2, revisions_left: 3, total_revisions: 0,
      current_server_time: STAMP });
    assert.strictEqual(lines.length, 1, `${lines.length} snap debug lines`);
    assert.strictEqual(lines[0].meta.snapped, false, JSON.stringify(lines[0].meta));
  });

  await check('3. no server stamp logs snapped false', async () => {
    const { lines } = await readWith({ bid_closing_in: 600, vendor_rank: 2, revisions_left: 3, total_revisions: 0 });
    assert.strictEqual(lines.length, 1, `${lines.length} snap debug lines`);
    assert.strictEqual(lines[0].meta.snapped, false, JSON.stringify(lines[0].meta));
  });

  await check('4. control: the snapped close is still a whole second', async () => {
    const { s } = await readWith({ bid_closing_in: 600, vendor_rank: 2, revisions_left: 3, total_revisions: 0,
      current_server_time: STAMP });
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.closesAtMs % 1000, 0, `closesAtMs ${s.closesAtMs}`);
  });

  console.log(`${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, 4, `expected 4 checks, ran ${pass}`);
  process.exit(0);
})().catch((e) => { console.error('FAIL test-gocomet-snap-debug-line:', e && e.message); process.exit(1); });
