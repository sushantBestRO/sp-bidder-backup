'use strict';
/**
 * The GoComet server clock adds back the return leg its stamps arrive late by.
 *
 * A bidding-data stamp is read on the box one return leg after GoComet wrote it, so every sample
 * under-reads the offset by that leg. The adapter feeds each read's measured round trip to the
 * estimator, which adds half the smallest one back. The engine times a provisional round shot on this
 * clock (ruling 52), so without the round trip every shot is decided a return leg late. Nothing pinned
 * the feed (mutation critique, PR-1).
 *
 * Each GET takes 60 ms out and 60 ms back; GoComet's clock runs 5,000 ms ahead of the box.
 *
 *   node scripts/test-gocomet-clock-corrects-for-round-trip.js
 */
for (const k of Object.keys(process.env)) if (/^GC_/.test(k)) delete process.env[k];

const assert = require('assert');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');

const LEG_MS = 60;
const SERVER_AHEAD_MS = 5_000;

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 86_400, user_id: 'u1', client_id: 'c1', token_type: 'vendor' })}.sig`;

(async () => {
  let now = 1_790_000_000_000;
  const fetchImpl = async (url) => {
    now += LEG_MS;
    const body = url.includes('/bidding-data')
      ? { data: { bid_closing_in: 600, vendor_rank: 2, total_revisions: 0, revisions_left: 3,
        current_server_time: new Date(now + SERVER_AHEAD_MS).toISOString() } }
      : {};
    now += LEG_MS;
    return { status: url.includes('/bidding-data') ? 200 : 404, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const a = new GoCometAdapter({ token, fetchImpl, sleep: async () => {}, now: () => now });
  await a.login();
  const s = await a.getAuctionState('K1');
  assert.ok(s.ok, `the read failed: ${JSON.stringify(s)}`);
  assert.strictEqual(s.serverOffsetMs, SERVER_AHEAD_MS,
    `published server offset ${s.serverOffsetMs} ms, GoComet runs ${SERVER_AHEAD_MS} ms ahead`);
  console.log('  ok  1. the published server offset includes the return leg the stamp arrived late by');
  console.log('\n1/1 checks passed');
})().catch((e) => { console.log(`FAIL: ${e.message}`); process.exit(1); });
