'use strict';
/**
 * A PLATFORM-REPORTED ZERO REVISION BUDGET IS HONOURED AS ZERO BY THE MANUAL SNIPE HARNESS.
 *
 * Regression target: A029. SnipeHarness.arm read `load.revisionLimit || 3`, so a load reporting
 * 0 revisions left got a budget of 3 and the live-bid tool fired into it. Only an absent limit
 * takes the tool's own default of 3; 1 and 2 were always honoured and stay so.
 *
 *   node scripts/test-snipe-harness-zero-revisions.js
 */
const { SnipeHarness } = require('../src/engine/snipeHarness');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

function harness(revisionLimit) {
  const placed = [];
  const adapter = { writeEnabled: false, placeBid: async (id, price) => { placed.push(price); return { accepted: true, status: 201 }; } };
  // Outranked, 2s from a hard close: the harness's own walk wants to fire the floor snipe here.
  const sock = { watch() {}, state() { return { myRank: 3 }; }, closesInMs() { return 2_000; } };
  const h = new SnipeHarness({ realAdapter: adapter, sock, log: () => {} });
  const load = { id: 991, lane: { origin: 'A', destination: 'B' }, equipment: '32FT', companyName: 'X',
    softClose: false, closesAt: Date.now() + 2_000, rules: {}, shipmentType: 'FTL' };
  if (revisionLimit !== undefined) load.revisionLimit = revisionLimit;
  return { h, placed, load };
}

(async () => {
  {
    const { h, placed, load } = harness(0);
    h.arm(load, { cost: 10_000, live: true });
    h.currentRung = 0; h.firedRungs.add(0);
    await h._tick();
    h.stop();
    ok(h.bidLimit === 0, `a reported limit of 0 is a budget of 0 (got ${h.bidLimit})`);
    ok(placed.length === 0, `no bid is placed on a load with no revisions left (placed ${placed.length})`);
  }
  {
    const { h, load } = harness(undefined);
    h.arm(load, { cost: 10_000, live: false });
    h.stop();
    ok(h.bidLimit === 3, `an absent limit keeps the tool's default of 3 (got ${h.bidLimit})`);
  }
  {
    const { h, load } = harness(null);
    h.arm(load, { cost: 10_000, live: false });
    h.stop();
    ok(h.bidLimit === 3, `a null limit keeps the tool's default of 3 (got ${h.bidLimit})`);
  }
  for (const n of [1, 2, 30]) {
    const { h, load } = harness(n);
    h.arm(load, { cost: 10_000, live: false });
    h.stop();
    ok(h.bidLimit === n, `a reported limit of ${n} is honoured as ${n} (got ${h.bidLimit})`);
  }
  {
    const { h, placed, load } = harness(2);
    h.arm(load, { cost: 10_000, live: true });
    h.currentRung = 0; h.firedRungs.add(0);
    await h._tick();
    h.stop();
    ok(placed.length === 1, `a load with revisions left still gets its floor snipe (placed ${placed.length})`);
  }

  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
