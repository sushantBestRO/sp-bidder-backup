'use strict';
/**
 * GOCOMET: THE PRE-BUZZER QUOTE REFRESH YIELDS TO A SIBLING'S DECISIVE READ AND DIES WITH ITS LOAD.
 *
 * Review of 9b2dd20 (non-blocking 3). The refresh at close - 8.5 s was a WRITE-class read that skips
 * the per-enquiry gate and outranks every read, so on an account with two endgames it could take the
 * slot of a sibling's read inside that sibling's final seconds. Its timer also outlived a stop or a
 * kill, so a stopped load still fetched a quote.
 *
 * Real GoCometAdapter (and real BidEngine for 3-4) over a fake GoComet on the virtual clock.
 *   1. a refresh queued beside a sibling's HOT read, the sibling inside its horizon: the sibling's
 *      read goes first.
 *   2. control: with no sibling waiting, the refresh goes at the next slot.
 *   3. engine.stop(load) before the refresh fires: no quote read for it afterwards.
 *   4. engine.kill() before the refresh fires: the same.
 *
 *   node scripts/test-gocomet-shot-refresh.js
 */
process.env.LOG_LEVEL = 'silent';

const assert = require('assert');
const vt = require('./lib/virtual-time');
const { createGoCometAccount, armGoComet } = require('./lib/gocomet-portal-sim');

async function settle(p, maxMs = 60_000) {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  const end = vt.now() + maxMs;
  while (!done && vt.now() < end) await vt.runUntil(vt.now() + 50);
  return p;
}

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message)); }
}

async function queuedPair({ withSibling }) {
  const base = Math.ceil((vt.now() + 3_600_000) / 1000) * 1000;
  const acct = createGoCometAccount({ enquiries: [{ key: 'Y', closeAt: base, rank: 3 }, { key: 'X', closeAt: base + 2_500, rank: 3 }],
    bidEnabled: false });
  const a = acct.adapter;
  await settle(a.login());
  vt.clock.now = base - 20_000;
  await settle(a.getAuctionState('X'));
  await settle(a.getAuctionState('Y'));
  vt.clock.now = base - 5_000;
  await settle(a.getAuctionState('Y'));
  const order = [];
  const refresh = a._refreshPreparedQuote('X').then(() => order.push('refresh X'));
  const read = withSibling ? a.getAuctionState('Y').then(() => order.push('state Y')) : Promise.resolve();
  await settle(Promise.all([refresh, read]));
  return { acct, base, order };
}

async function stoppedBeforeRefresh(how) {
  const base = Math.ceil((vt.now() + 3_600_000) / 1000) * 1000;
  const acct = createGoCometAccount({ enquiries: [{ key: 'S', closeAt: base, rank: 1 }] });
  vt.clock.now = base - 90_000;
  armGoComet(acct, 'S');
  await vt.runUntil(base - 12_000);
  const scheduled = acct.adapter._shotRefresh.has('S');
  if (how === 'stop') acct.engine.stop('S'); else acct.engine.kill('test');
  const after = acct.wire.length;
  await vt.runUntil(base + 5_000);
  acct.engine.kill('test done');
  return { scheduled, quotesAfter: acct.wire.slice(after).filter((w) => w.kind === 'quotes') };
}

(async () => {
  await check('1. a refresh queued beside a sibling\'s decisive read goes after it', async () => {
    const { order } = await queuedPair({ withSibling: true });
    assert.deepStrictEqual(order, ['state Y', 'refresh X']);
  });
  await check('2. control: with no sibling waiting, the refresh goes', async () => {
    const { acct, base } = await queuedPair({ withSibling: false });
    const q = acct.wire.filter((w) => w.kind === 'quotes' && w.key === 'X');
    assert.ok(q.length >= 1 && q[0].sentAt <= base - 3_000, `refresh read at ${q.length ? q[0].sentAt - base : 'never'}`);
  });
  await check('3. engine.stop cancels the load\'s pending refresh', async () => {
    const r = await stoppedBeforeRefresh('stop');
    assert.ok(r.scheduled, 'HARNESS: no refresh was scheduled before the stop');
    assert.deepStrictEqual(r.quotesAfter.map((w) => w.sentAt), [], 'a quote was read after the stop');
  });
  await check('4. engine.kill cancels it too', async () => {
    const r = await stoppedBeforeRefresh('kill');
    assert.ok(r.scheduled, 'HARNESS: no refresh was scheduled before the kill');
    assert.deepStrictEqual(r.quotesAfter.map((w) => w.sentAt), [], 'a quote was read after the kill');
  });

  vt.restore();
  console.log(`${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, 4, `expected 4 checks, ran ${pass}`);
  process.exit(0);
})().catch((e) => { vt.restore(); console.error('FAIL test-gocomet-shot-refresh:', e && e.stack); process.exit(1); });
