'use strict';
/**
 * GOCOMET READ QUEUE: WHO GETS THE NEXT SLOT WHEN TWO LOADS ARE IN THEIR ENDGAME.
 *
 * Regression target: the 2026-09-25 Waaree loss (260925RP1C). Each rule is pinned on its own, on
 * the real GoCometAdapter over a fake GoComet on a virtual clock (scripts/lib):
 *   1. re-class at selection: a read queued as POLL whose load enters its decisive horizon while it
 *      waits competes as HOT, so a sibling's HOT reads cannot hold it to the 15 s aging bound.
 *   2. two HOT loads alternate: each read goes to the load read longest ago, so neither takes two
 *      slots in a row while the other waits. Named reversal (review of 9b2dd20, blocking 2): this
 *      check used to pin nearest-close-first, which let the nearer load take every slot of a pair
 *      closing 3 s apart; the nearer close now only breaks a tie.
 *   3. post-close HOT is capped: a load whose close has passed with no later close seen is HOT for a
 *      few seconds, not for as long as its last live read stays recent (up to 10 s).
 *   4. control: a genuine extension keeps the load in play: after a read shows the close moved, the
 *      load is HOT again inside the new close's horizon.
 *   5. a read that arrives while the queue sleeps toward a later slot is not held to that sleep: a
 *      quote read for a bid, queued behind a POLL slot 4 s away, goes within the 1 s ceiling.
 *   6. the ceiling holds: no two GETs start less than 1,000 ms apart in any of the above.
 *
 *   node scripts/test-gocomet-read-queue-endgames.js
 */
process.env.LOG_LEVEL = 'silent';

const assert = require('assert');
const vt = require('./lib/virtual-time');
const { createGoCometAccount } = require('./lib/gocomet-portal-sim');

const HOT = 2;
const POLL = 1;

// Writes off, so no quote is prepared in the background and only the reads under test reach the queue.
function account(closes) {
  const base = Math.ceil((vt.now() + 3_600_000) / 1000) * 1000;
  const enquiries = Object.entries(closes).map(([key, off]) => ({ key, closeAt: base + off, rank: 3 }));
  const acct = createGoCometAccount({ enquiries, bidEnabled: false });
  return { acct, base, a: acct.adapter };
}

// Run the virtual clock until `p` settles, as the engine's own awaits would see it.
async function settle(p, maxMs = 60_000) {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  const end = vt.now() + maxMs;
  while (!done && vt.now() < end) await vt.runUntil(vt.now() + 50);
  return p;
}

function gets(acct) { return acct.wire.filter((w) => w.method === 'GET'); }
function tightGaps(acct) {
  const s = gets(acct).map((w) => w.sentAt).sort((x, y) => x - y);
  const out = [];
  for (let i = 1; i < s.length; i += 1) if (s[i] - s[i - 1] < 1_000) out.push(s[i] - s[i - 1]);
  return out;
}

let pass = 0;
let fail = 0;
const allAccts = [];
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message)); }
}

// Keep one load's reads coming as fast as the queue gives them, as an engine in its endgame does.
function hammer(a, key, until) {
  (async () => { while (vt.now() < until) await a.getAuctionState(key); })();
}

(async () => {
  await check('1. a POLL read whose load enters its horizon while queued competes as HOT', async () => {
    const { acct, base, a } = account({ SIB: 500, LATE: 0 });
    allAccts.push(acct);
    await settle(a.login());
    vt.clock.now = base - 11_000;
    await settle(a.getAuctionState('SIB'));
    vt.clock.now = base - 8_000;
    await settle(a.getAuctionState('LATE'));
    hammer(a, 'SIB', base + 3_000);
    const done = a.getAuctionState('LATE');
    await vt.runUntil(base + 3_000);
    const res = await settle(done);
    const served = acct.wire.filter((w) => w.key === 'LATE' && w.kind === 'state').pop();
    assert.ok(res && res.ok, 'the LATE read never came back');
    assert.ok(served.at < base,
      `LATE's queued read was served ${served.at - base} ms from its close, behind the sibling's HOT reads`);
  });

  await check('2. two HOT loads alternate slots while both are before their close', async () => {
    const { acct, base, a } = account({ FAR: 1_000, NEAR: 0 });
    allAccts.push(acct);
    await settle(a.login());
    vt.clock.now = base - 11_000;
    await settle(a.getAuctionState('FAR'));
    await settle(a.getAuctionState('NEAR'));
    vt.clock.now = base - 6_000;
    hammer(a, 'FAR', base);
    hammer(a, 'NEAR', base);
    await vt.runUntil(base);
    const seq = acct.wire.filter((w) => w.kind === 'state' && w.sentAt >= base - 6_000 && w.sentAt < base).map((w) => w.key);
    const repeats = seq.filter((k, i) => i > 0 && k === seq[i - 1]).length;
    assert.ok(seq.length >= 4, `HARNESS: only ${seq.length} reads in the last 6 s`);
    assert.strictEqual(repeats, 0, `one load took consecutive slots: ${seq.join(',')}`);
  });

  await check('3. post-close HOT lasts seconds, not until the read goes stale', async () => {
    const { acct, base, a } = account({ K: 0 });
    allAccts.push(acct);
    await settle(a.login());
    vt.clock.now = base - 1_000;
    await settle(a.getAuctionState('K'));
    vt.clock.now = base + 2_000;
    assert.strictEqual(a._readPriorityFor('K'), HOT, 'not HOT 2 s after its close');
    vt.clock.now = base + 5_000;
    assert.strictEqual(a._readPriorityFor('K'), POLL, 'still HOT 5 s after a close with no later close seen');
  });

  await check('4. a genuine extension puts the load back in play at its new close', async () => {
    const { acct, base, a } = account({ K: 0 });
    allAccts.push(acct);
    await settle(a.login());
    vt.clock.now = base - 3_000;
    await settle(a.getAuctionState('K'));
    acct.byKey.get('K').closeAt = base + 299_000;
    vt.clock.now = base + 1_000;
    await settle(a.getAuctionState('K'));
    vt.clock.now = base + 299_000 - 8_000;
    await settle(a.getAuctionState('K'));
    vt.clock.now = base + 299_000 - 5_000;
    assert.strictEqual(a._readPriorityFor('K'), HOT, 'not HOT inside the extended close\'s horizon');
    vt.clock.now = base + 60_000;
    assert.strictEqual(a._readPriorityFor('K'), POLL, 'HOT far from the extended close');
  });

  await check('5. a quote read arriving while the queue sleeps toward a later slot goes within the ceiling', async () => {
    const { acct, base, a } = account({ P: 60_000, W: 60_000 });
    allAccts.push(acct);
    await settle(a.login());
    vt.clock.now = base;
    await settle(a.getAuctionState('P'));
    const pollRead = a.getAuctionState('P');
    await vt.runUntil(base + 1_000);
    const queuedAt = vt.now();
    const quote = a._fetchQuoteForWrite('W');
    await vt.runUntil(base + 6_000);
    await settle(Promise.all([pollRead, quote]));
    const q = acct.wire.find((w) => w.key === 'W' && w.kind === 'quotes');
    assert.ok(q, 'the quote read never went');
    assert.ok(q.sentAt - queuedAt <= 1_000, `the quote read waited ${q.sentAt - queuedAt} ms behind a sleeping POLL slot`);
  });

  await check('6. no two GETs start less than 1,000 ms apart', async () => {
    for (const acct of allAccts) assert.deepStrictEqual(tightGaps(acct), []);
  });

  vt.restore();
  console.log(`${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, 6, `expected 6 checks, ran ${pass}`);
  process.exit(0);
})().catch((e) => { vt.restore(); console.error('FAIL test-gocomet-read-queue-endgames:', e && e.stack); process.exit(1); });
