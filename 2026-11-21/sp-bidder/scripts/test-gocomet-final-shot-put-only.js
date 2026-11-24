'use strict';
/**
 * GOCOMET: A SHOT DECIDED IN THE FINAL WINDOW GOES ON A QUOTE PREPARED AHEAD OF IT - THE PUT ALONE.
 *
 * Regression target: 2026-09-26, Waaree 260925NP9V. The one bid of the round was decided with
 * 3,532 ms left, took 4,578 ms (GET, GET, PUT) and landed after our derived close. The quote prepared
 * during the approach had passed its 5 s freshness bound by the time the buzzer read decided the
 * shot, so the shot fetched and confirmed a quote first. A load held at rank 1 until a rival moves in
 * the last seconds takes no middle shot, so no accepted submit refreshes the quote either.
 *
 * Real BidEngine, real GoCometAdapter, a fake GoComet on one virtual clock (scripts/lib). The load
 * leads at rank 1 through the approach and a rival takes rank 1 at 7 s to close.
 *   1. the shot is decided inside the final window and before the 4,500 ms write runway. f04380c
 *      decided it at 3,920 ms: the read that would decide it sat behind a POLL slot (the live bid was
 *      decided at 3,532 ms).
 *   2. it sends no GET between the read it was decided on and its PUT.
 *   3. every shot lands before close.
 *   4. control: a load outranked from the start (middle shot, then buzzer shot) keeps its buzzer shot
 *      PUT-only too.
 *   5. the 1 GET/s ceiling holds.
 *
 *   node scripts/test-gocomet-final-shot-put-only.js
 */
process.env.LOG_LEVEL = 'silent';

const assert = require('assert');
const vt = require('./lib/virtual-time');
const { createGoCometAccount, armGoComet } = require('./lib/gocomet-portal-sim');

async function run(enquiry) {
  const base = Math.ceil((vt.now() + 3_600_000) / 1000) * 1000;
  const e = enquiry(base);
  const acct = createGoCometAccount({ enquiries: [e] });
  vt.clock.now = base - 90_000;
  armGoComet(acct, e.key);
  await vt.runUntil(base + 15_000);
  acct.engine.kill('test done');
  return { acct, e, base };
}

function shots({ acct, e }) {
  return acct.wire.filter((w) => w.key === e.key && w.kind === 'submit').map((s) => {
    const decidingRead = acct.wire.filter((w) => w.key === e.key && w.kind === 'state' && w.at <= s.sentAt).pop();
    const between = acct.wire.filter((w) => w.key === e.key && w.method === 'GET' && w.kind !== 'state'
      && decidingRead && w.sentAt >= decidingRead.at && w.sentAt < s.sentAt);
    return { sentAt: s.sentAt - e.closeAt, landed: s.at - e.closeAt, status: s.status, getsBefore: between.length,
      decidedAt: decidingRead ? decidingRead.at - e.closeAt : null };
  });
}

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (err) { fail++; console.log('  FAIL ' + name + ': ' + (err && err.message)); }
}

(async () => {
  const late = await run((base) => ({ key: '260925NP9V', closeAt: base, rank: 1,
    rankAt: (t) => (t < base - 7_000 ? 1 : 3) }));
  const lateShots = shots(late);

  await check('1. the shot is decided before the write runway (4,500 ms), inside the final window', async () => {
    assert.ok(lateShots.length >= 1, 'no shot was taken after the rival moved in');
    const s = lateShots[0];
    assert.ok(s.decidedAt >= -6_500 && s.decidedAt <= -4_500,
      `the shot was decided ${-s.decidedAt} ms before close (window 6,500 to 4,500)`);
  });

  await check('2. that shot sends no GET between its deciding read and its PUT', async () => {
    const s = lateShots[0];
    assert.ok(s, 'no shot');
    assert.strictEqual(s.getsBefore, 0, `the shot sent ${s.getsBefore} GET(s) before its PUT (${JSON.stringify(s)})`);
  });

  await check('3. every shot lands before close', async () => {
    for (const s of lateShots) assert.ok(s.status === 200 && s.landed < 0, `a shot landed ${s.landed} ms from close with ${s.status}`);
  });

  const early = await run((base) => ({ key: '260925EARLY', closeAt: base, rank: 4 }));
  await check('4. control: an outranked load\'s buzzer shot is PUT-only too', async () => {
    const s = shots(early);
    assert.ok(s.length >= 2, `expected the middle and buzzer shots, saw ${s.length}`);
    const buzzer = s[s.length - 1];
    assert.strictEqual(buzzer.getsBefore, 0, JSON.stringify(buzzer));
    assert.ok(s.every((x) => x.status === 200 && x.landed < 0), JSON.stringify(s));
  });

  await check('5. the 1 GET/s ceiling holds', async () => {
    for (const r of [late, early]) {
      const starts = r.acct.wire.filter((w) => w.method === 'GET').map((w) => w.sentAt).sort((a, b) => a - b);
      for (let i = 1; i < starts.length; i += 1) assert.ok(starts[i] - starts[i - 1] >= 1_000, 'two GETs under 1,000 ms apart');
    }
  });

  vt.restore();
  console.log(`${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, 5, `expected 5 checks, ran ${pass}`);
  process.exit(0);
})().catch((err) => { vt.restore(); console.error('FAIL test-gocomet-final-shot-put-only:', err && err.stack); process.exit(1); });
