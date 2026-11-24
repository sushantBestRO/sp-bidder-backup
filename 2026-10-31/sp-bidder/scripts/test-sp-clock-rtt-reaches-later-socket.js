'use strict';
/**
 * Round trips measured before the socket exists reach it when it attaches.
 *
 * The SP clock corrects every heartbeat by half the smallest measured round trip (P1). Login's REST
 * calls are the first round trips measured, and they complete before connectSocket builds the socket,
 * so the adapter keeps them and replays them into the socket on attach. Without the replay the socket
 * runs on its assumed round trip until the first bid write measures one. Nothing pinned the replay
 * (mutation critique, PR-1).
 *
 *   node scripts/test-sp-clock-rtt-reaches-later-socket.js
 */
const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

let pass = 0;
const ok = (n, m) => { console.log(`  ok  ${n}. ${m}`); pass++; };

(async () => {
  let now = 1_790_000_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const fetchImpl = async () => { now += 84; return { status: 200, headers: { get: () => null }, text: async () => '{}' }; };
    const adapter = new RealSuperProcureAdapter({ token: 'test-token', fetchImpl, sleep: async () => {} });
    await adapter._get('/sp/base/getAvailableViews');
    await adapter._get('/sp/base/getHeader?relationShipType=Carrier&isWeb=1');

    const seen = [];
    adapter.attachSocket({ noteRoundTrip: (ms) => seen.push(ms) });
    assert.deepStrictEqual(seen, [84, 84], `the socket attached after two REST round trips received ${JSON.stringify(seen)}`);
    ok(1, 'round trips measured before the socket attached are replayed into it');

    await adapter._get('/sp/base/getHeader?relationShipType=Carrier&isWeb=1');
    assert.deepStrictEqual(seen, [84, 84, 84], `a round trip after attach did not reach the socket: ${JSON.stringify(seen)}`);
    ok(2, 'a round trip measured after the socket attached reaches it directly');
  } finally { Date.now = realNow; }
  console.log(`\n${pass}/2 checks passed`);
})().catch((e) => { console.log(`FAIL: ${e.message}`); process.exit(1); });
