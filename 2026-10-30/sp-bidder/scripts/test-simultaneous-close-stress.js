'use strict';
/**
 * STRESS: FIVE SUPERPROCURE LOADS ON ONE ACCOUNT AND TWO GOCOMET LOADS ON ANOTHER CLOSE IN ONE SECOND.
 *
 * Both engines, both real adapters, one process and one virtual clock (scripts/lib), as on the box.
 * Every load is outranked after each of our bids, so each runs its whole final sequence:
 * SuperProcure walks its 4-price band to the floor (the establish, two step-downs, the floor);
 * GoComet takes its final-round middle shot and its buzzer floor (the step-down walk between them is
 * the final-window-walk branch, not this one).
 *
 * Pinned:
 *   1. every write the engines decided was decided before its load's close, and accepted before it.
 *   2. every SuperProcure load lands at least 3 writes and its floor; every GoComet load lands 2 and
 *      its floor.
 *   3. no write was dropped: no bids_per_min_cap hold, no refusal, no rejected write; any hold that
 *      did happen would have been a loud alert (asserted by name, so a new silent path shows here).
 *   4. every load's last live read was within 3 s of its close (no stale_read_at_close alert).
 *
 *   node scripts/test-simultaneous-close-stress.js
 */
process.env.LOG_LEVEL = 'silent';

const assert = require('assert');
const vt = require('./lib/virtual-time');
const { createSuperProcureAccount, armSuperProcure } = require('./lib/superprocure-portal-sim');
const { createGoCometAccount, armGoComet } = require('./lib/gocomet-portal-sim');

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message)); }
}

(async () => {
  const base = Math.ceil((vt.now() + 3_600_000) / 1000) * 1000;
  const spLoads = [0, 150, 400, 700, 900].map((o, i) => ({ id: 2600000 + i, closeAt: base + o, rank: null }));
  const gcLoads = [300, 800].map((o, i) => ({ key: `260926S${i}`, closeAt: base + o, rank: null }));
  const sp = createSuperProcureAccount({ loads: spLoads });
  const gc = createGoCometAccount({ enquiries: gcLoads, rankAfterSubmit: 2 });
  vt.clock.now = base - 120_000;
  const spLadders = spLoads.map((l) => armSuperProcure(sp, l).ladder.slice());
  const gcLadders = gcLoads.map((e) => armGoComet(gc, e.key).ladder.slice());
  await vt.runUntil(base + 15_000);
  sp.engine.kill('test done');
  gc.engine.kill('test done');

  const closeOf = new Map([...spLoads.map((l) => [String(l.id), l.closeAt]), ...gcLoads.map((e) => [e.key, e.closeAt])]);
  const events = [...sp.events, ...gc.events];
  const decided = events.filter((e) => (e.type === 'bid_placed' || e.type === 'bid_rejected') && e.decidedAt != null);
  const summary = [];

  await check('1. every write was decided and accepted before its load\'s close', async () => {
    const late = decided.filter((e) => e.decidedAt >= closeOf.get(String(e.auctionId)));
    const wireLate = [...sp.wire.map((w) => ({ id: w.id, at: w.at, status: w.status })),
      ...gc.wire.filter((w) => w.kind === 'submit').map((w) => ({ id: w.key, at: w.at, status: w.status }))]
      .filter((w) => w.id && (w.at >= closeOf.get(w.id) || (w.status !== 201 && w.status !== 200)));
    assert.deepStrictEqual({ late: late.length, wireLate }, { late: 0, wireLate: [] });
  });

  await check('2. every SuperProcure load lands 3+ writes and its floor; every GoComet load 2 and its floor', async () => {
    const bad = [];
    spLoads.forEach((l, i) => {
      const w = sp.wire.filter((x) => x.id === String(l.id) && x.status === 201);
      summary.push(`SP ${l.id}: ${w.length} writes, last ${((w[w.length - 1].sentAt - l.closeAt) / 1000).toFixed(2)} s`);
      if (w.length < 3 || !w.some((x) => x.price === spLadders[i][spLadders[i].length - 1])) bad.push(`SP ${l.id}: ${w.map((x) => x.price)}`);
    });
    gcLoads.forEach((e, i) => {
      const w = gc.wire.filter((x) => x.key === e.key && x.kind === 'submit' && x.status === 200);
      summary.push(`GC ${e.key}: ${w.length} writes, last ${w.length ? ((w[w.length - 1].sentAt - e.closeAt) / 1000).toFixed(2) : '-'} s`);
      if (w.length < 2 || !w.some((x) => x.price === gcLadders[i][gcLadders[i].length - 1])) bad.push(`GC ${e.key}: ${w.map((x) => x.price)}`);
    });
    assert.deepStrictEqual(bad, []);
  });

  await check('3. no write was held by a rate cap or refused', async () => {
    const held = events.filter((e) => e.type === 'alert' && ['bids_per_min_cap', 'no_revisions_left', 'bid_cap_exhausted',
      'submission_window_closed'].includes(e.kind));
    const rejected = events.filter((e) => e.type === 'bid_rejected');
    assert.deepStrictEqual({ held: held.map((e) => `${e.kind}:${e.auctionId}`), rejected: rejected.length }, { held: [], rejected: 0 });
  });

  await check('4. every load\'s last live read was within 3 s of its close', async () => {
    const stale = events.filter((e) => e.type === 'alert' && e.kind === 'stale_read_at_close');
    assert.deepStrictEqual(stale.map((e) => `${e.auctionId}:${e.lastReadBeforeCloseMs}`), []);
  });

  console.log(summary.map((l) => '      ' + l).join('\n'));
  vt.restore();
  console.log(`${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, 4, `expected 4 checks, ran ${pass}`);
  process.exit(0);
})().catch((e) => { vt.restore(); console.error('FAIL test-simultaneous-close-stress:', e && e.stack); process.exit(1); });
