'use strict';
/**
 * GOCOMET: TWO ENDGAMES ON ONE ACCOUNT BOTH GET THEIR READS AND BOTH SHOTS LAND BEFORE CLOSE.
 *
 * Regression target: 2026-09-25, Waaree enquiry 260925RP1C lost with a price in hand. A sibling
 * enquiry on the same account closed 1 s later; its HOT reads took every slot of the 1 GET/s queue,
 * RP1C's read had been queued as POLL at about 12 s to close and stayed POLL, and it was served only
 * after the 15 s aging bound: 4.4 s after close. The bid went 10 s after close and got a 422.
 *
 * Review of 9b2dd20 (blocking 2): two endgames 3.0-3.5 s apart still starved the later load, whose
 * queued read aged past the 10 s freshness bound, was demoted to POLL and lost every slot to the
 * nearer load and then to that load's post-close reads.
 *
 * Real BidEngine, real GoCometAdapter, a fake GoComet on one virtual clock (scripts/lib). Every load
 * is outranked, so each wants its shot.
 *   1. two loads, closes 0 to 8 s apart (0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 8 s): each load gets
 *      a state read inside its decisive horizon (6.5 s) before close, and every submit of each is
 *      accepted before its close, with no 422.
 *   2. three loads, closes spread over 0 to 6 s: the same.
 *   3. control: one load alone still reads inside its horizon and lands its shots before close.
 *   4. the 1 GET/s ceiling holds in every run: no two GETs start less than 1,000 ms apart.
 *
 *   node scripts/test-gocomet-two-endgames-one-account.js
 */
process.env.LOG_LEVEL = 'silent';

const assert = require('assert');
const vt = require('./lib/virtual-time');
const { createGoCometAccount, armGoComet } = require('./lib/gocomet-portal-sim');

const HORIZON_MS = 6_500;

async function run(closeOffsetsMs) {
  const base = Math.ceil((vt.now() + 3_600_000) / 1000) * 1000;
  const enquiries = closeOffsetsMs.map((off, i) => ({ key: `260925W${i}`, closeAt: base + off, rank: 4 }));
  const acct = createGoCometAccount({ enquiries });
  vt.clock.now = base - 90_000;
  for (const e of enquiries) armGoComet(acct, e.key);
  await vt.runUntil(base + Math.max(...closeOffsetsMs) + 15_000);
  acct.engine.kill('test done');
  return { acct, enquiries };
}

function verdictFor({ acct, enquiries }) {
  const problems = [];
  for (const e of enquiries) {
    const reads = acct.wire.filter((w) => w.key === e.key && w.kind === 'state');
    const inHorizon = reads.filter((w) => w.at < e.closeAt && e.closeAt - w.at <= HORIZON_MS);
    const submits = acct.wire.filter((w) => w.key === e.key && w.kind === 'submit');
    if (!inHorizon.length) {
      const last = reads.filter((w) => w.at < e.closeAt).pop();
      problems.push(`${e.key}: no read inside its ${HORIZON_MS} ms horizon (last read before close ${last ? e.closeAt - last.at : 'none'} ms out)`);
    }
    if (!submits.length) problems.push(`${e.key}: no submit at all`);
    for (const s of submits) {
      if (s.status !== 200 || s.at >= e.closeAt) problems.push(`${e.key}: submit ${s.status} landed ${s.at - e.closeAt} ms after close`);
    }
  }
  return problems;
}

function ceilingGaps({ acct }) {
  const starts = acct.wire.filter((w) => w.method === 'GET').map((w) => w.sentAt).sort((a, b) => a - b);
  const tight = [];
  for (let i = 1; i < starts.length; i += 1) if (starts[i] - starts[i - 1] < 1_000) tight.push(starts[i] - starts[i - 1]);
  return tight;
}

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message)); }
}

(async () => {
  const runs = [];
  const sweep = async (cases) => {
    const bad = [];
    for (const offsets of cases) {
      const r = await run(offsets);
      runs.push(r);
      for (const p of verdictFor(r)) bad.push(`[${offsets.join(',')}] ${p}`);
    }
    return bad;
  };
  await check('1. two loads 0 to 8 s apart: each reads inside its horizon and lands every shot before close', async () => {
    const bad = await sweep([0, 500, 1_000, 1_500, 2_000, 2_500, 3_000, 3_500, 4_000, 5_000, 6_000, 8_000].map((d) => [0, d]));
    assert.deepStrictEqual(bad, []);
  });
  await check('2. three loads spread over 0 to 6 s: the same', async () => {
    const bad = await sweep([[0, 0, 0], [0, 500, 1_000], [0, 1_000, 2_000], [0, 1_500, 3_000], [0, 2_000, 4_000],
      [0, 3_000, 6_000], [0, 0, 3_000], [0, 3_000, 3_500]]);
    assert.deepStrictEqual(bad, []);
  });
  await check('3. control: one load alone reads inside its horizon and lands every shot before close', async () => {
    const r = await run([0]);
    runs.push(r);
    assert.deepStrictEqual(verdictFor(r), []);
    assert.ok(r.acct.wire.filter((w) => w.kind === 'submit').length >= 1, 'the lone load placed nothing');
  });
  await check('4. the 1 GET/s ceiling holds in every run', async () => {
    for (const r of runs) assert.deepStrictEqual(ceilingGaps(r), [], 'GETs started closer than 1,000 ms apart');
  });

  vt.restore();
  console.log(`${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, 4, `expected 4 checks, ran ${pass}`);
  process.exit(0);
})().catch((e) => { vt.restore(); console.error('FAIL test-gocomet-two-endgames-one-account:', e && e.stack); process.exit(1); });
