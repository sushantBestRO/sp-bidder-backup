'use strict';
/**
 * GOCOMET: A CLOSED LOAD FALLS BACK TO THE ORDINARY READ CADENCE AFTER ITS SHORT POST-CLOSE WINDOW.
 *
 * Regression target (review of 9b2dd20, blocking 1): once a load's post-close HOT window (3 s) ended,
 * its reads were POLL by class but still released every 1 s, because the "turns HOT at its horizon"
 * readiness never checked that the close had passed. Over the ~300 s the engine keeps a soft-close
 * load open after its close, that was 302 GETs where f04380c issued 67, all on the account's shared
 * 1 GET/s budget.
 *
 * Real BidEngine, real GoCometAdapter, fake GoComet on the virtual clock (scripts/lib). One load, bid
 * on and closed, then watched for 600 s.
 *   1. from 10 s after close, consecutive state reads of the closed load are at least 4.5 s apart:
 *      the 5 s POLL spacing f04380c also falls back to there.
 *   2. state reads from +3 s to +304 s after close number no more than f04380c's 67.
 *
 *   node scripts/test-gocomet-closed-load-read-cadence.js
 */
process.env.LOG_LEVEL = 'silent';

const assert = require('assert');
const vt = require('./lib/virtual-time');
const { createGoCometAccount, armGoComet } = require('./lib/gocomet-portal-sim');

const BASELINE_F04380C = 67;

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message)); }
}

(async () => {
  const base = Math.ceil((vt.now() + 3_600_000) / 1000) * 1000;
  const acct = createGoCometAccount({ enquiries: [{ key: 'K0', closeAt: base, rank: 4 }], rankAfterSubmit: 2 });
  vt.clock.now = base - 90_000;
  armGoComet(acct, 'K0');
  await vt.runUntil(base + 600_000);
  acct.engine.kill('test done');
  const post = acct.wire.filter((w) => w.kind === 'state' && w.sentAt > base + 3_000).map((w) => w.sentAt);

  await check('1. from 10 s after close, reads of the closed load are at least 4.5 s apart', async () => {
    const late = post.filter((t) => t >= base + 10_000);
    const gaps = [];
    for (let i = 1; i < late.length; i += 1) gaps.push(late[i] - late[i - 1]);
    const tight = gaps.filter((g) => g < 4_500);
    assert.deepStrictEqual(tight.length, 0, `${tight.length} of ${gaps.length} gaps under 4,500 ms (smallest ${Math.min(...gaps)} ms)`);
  });

  await check(`2. no more post-close state reads than f04380c (${BASELINE_F04380C}) over +3 s to +304 s`, async () => {
    const n = post.filter((t) => t <= base + 304_000).length;
    assert.ok(n <= BASELINE_F04380C, `${n} state reads`);
  });

  vt.restore();
  console.log(`${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, 2, `expected 2 checks, ran ${pass}`);
  process.exit(0);
})().catch((e) => { vt.restore(); console.error('FAIL test-gocomet-closed-load-read-cadence:', e && e.stack); process.exit(1); });
