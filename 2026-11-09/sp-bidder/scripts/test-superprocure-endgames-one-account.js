'use strict';
/**
 * SUPERPROCURE: SEVERAL ENDGAMES ON ONE ACCOUNT EACH GET FRESH READS AND LAND EVERY SHOT BEFORE CLOSE.
 *
 * Guard, from the 2026-09-25 GoComet loss (Waaree 260925RP1C): a sibling load's reads starved this
 * load's read across its close. SuperProcure's read path is the socket's in-memory cache (the only
 * request on it is the unknown-load listing, which an armed load never needs), and the engine's
 * write caps are per auction, so nothing is shared between loads to starve. This pins that it stays so.
 *
 * Real BidEngine, real RealSuperProcureAdapter over a socket stand-in and a fake createV2, on one
 * virtual clock (scripts/lib). Every load is outranked after each of our bids, so each walks its band
 * to the floor.
 *   1. two loads closing 1 s apart: each gets fresh reads inside its 2.5 s floor window, and every write
 *      is accepted before its close, the floor included.
 *   2. three loads closing within 1 s: the same.
 *   3. no write is held back by a rate cap (no bids_per_min_cap alert) and none is refused.
 *
 *   node scripts/test-superprocure-endgames-one-account.js
 */
process.env.LOG_LEVEL = 'silent';

const assert = require('assert');
const vt = require('./lib/virtual-time');
const { createSuperProcureAccount, armSuperProcure } = require('./lib/superprocure-portal-sim');

const FLOOR_WINDOW_MS = 2_500;

async function run(offsets) {
  const base = Math.ceil((vt.now() + 3_600_000) / 1000) * 1000;
  const loads = offsets.map((o, i) => ({ id: 2500000 + i, closeAt: base + o, rank: null }));
  const acct = createSuperProcureAccount({ loads });
  vt.clock.now = base - 120_000;
  const monitors = loads.map((l) => armSuperProcure(acct, l));
  await vt.runUntil(base + Math.max(...offsets) + 10_000);
  acct.engine.kill('test done');
  return { acct, loads, ladders: monitors.map((m) => m.ladder.slice()) };
}

function problems({ acct, loads, ladders }) {
  const out = [];
  loads.forEach((l, i) => {
    const id = String(l.id);
    const fresh = acct.reads.filter((r) => r.id === id && r.ok && r.at < l.closeAt && l.closeAt - r.at <= FLOOR_WINDOW_MS);
    if (fresh.length < 3) out.push(`${id}: ${fresh.length} fresh reads inside its floor window`);
    const writes = acct.wire.filter((w) => w.id === id && w.kind === 'submit');
    for (const w of writes) if (w.status !== 201 || w.at >= l.closeAt) out.push(`${id}: write ${w.price} ${w.status} at ${w.at - l.closeAt} ms`);
    const floor = ladders[i][ladders[i].length - 1];
    if (!writes.some((w) => w.price === floor && w.status === 201)) out.push(`${id}: the floor ${floor} never landed`);
  });
  return out;
}

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message)); }
}

(async () => {
  const runs = [];
  await check('1. two loads closing 1 s apart: fresh reads in each floor window, every write before close', async () => {
    const r = await run([0, 1_000]);
    runs.push(r);
    assert.deepStrictEqual(problems(r), []);
  });
  await check('2. three loads closing within 1 s: the same', async () => {
    const r = await run([0, 400, 1_000]);
    runs.push(r);
    assert.deepStrictEqual(problems(r), []);
  });
  await check('3. no rate-cap hold and no refused write', async () => {
    for (const r of runs) {
      const capped = r.acct.events.filter((e) => e.type === 'alert' && e.kind === 'bids_per_min_cap');
      const refused = r.acct.events.filter((e) => e.type === 'bid_rejected');
      assert.deepStrictEqual([capped.length, refused.length], [0, 0], 'a write was held or refused');
    }
  });

  vt.restore();
  console.log(`${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, 3, `expected 3 checks, ran ${pass}`);
  process.exit(0);
})().catch((e) => { vt.restore(); console.error('FAIL test-superprocure-endgames-one-account:', e && e.stack); process.exit(1); });
