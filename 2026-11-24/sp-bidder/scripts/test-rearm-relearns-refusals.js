'use strict';
/**
 * A DESK RE-ARM RE-LEARNS THE PORTAL'S REFUSALS - pressing Re-arm on a stopped load bids again.
 *
 * The portal's verdicts ride the intent across a restart and are dropped when the re-price epoch
 * moves. Re-price, clear-override and resume all move it; the operator's Re-arm on a stopped load did
 * not, so it carried a terminal verdict (a raise refusal, "auction has already ended") straight back
 * onto a load the desk had just told to bid. The load then stood down on its first tick with nothing
 * new said: the desk pressed a button and the bot stayed silent.
 *
 * WHAT MUST NOT MOVE: a re-arm still never re-spends a LANDED rung (check 3). That fact lives on the
 * intent's firedRungs, which the epoch does not touch.
 *
 *   node scripts/test-rearm-relearns-refusals.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { PriceRequestStore, armFromRequest } = require('../src/pricing/priceRequests');

let ran = 0, pass = 0;
const FAILURES = [];
const check = async (name, fn) => {
  ran++;
  try { await fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { FAILURES.push({ name, message: (e && e.message) ? e.message : String(e) }); console.log('  FAIL  ' + name); }
};
const EXPECTED_CHECKS = 4;
const file = path.join(os.tmpdir(), `rearm-relearns-${process.pid}.json`);
process.on('exit', () => {
  try { fs.unlinkSync(file); } catch (_) {}
  const bad = [];
  if (ran !== EXPECTED_CHECKS) bad.push(`only ${ran} of ${EXPECTED_CHECKS} checks ran - this file exited early`);
  if (pass !== EXPECTED_CHECKS) bad.push(`${EXPECTED_CHECKS - pass} of ${EXPECTED_CHECKS} checks failed`);
  if (!bad.length) { console.log(`\nre-arm re-learns refusals: ${pass}/${EXPECTED_CHECKS} checks passed`); return; }
  console.error(`\nCOMPLETION SENTINEL FAILED: ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});

// SuperProcure's numeric cap BELOW every rung but the first one we land: a raise refusal, terminal
// for submission on this load.
const RAISE_REFUSED = 'Amount is invalid. Amount should be less than or equal to 40000';

const adapter = {
  capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'unknown' }),
  ensureSession: async () => ({}),
  getAuctionState: async () => ({ ok: false }),
  placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
};
const wire = [];
function landFirstThenRefuse() {
  adapter.placeBid = async (_id, price) => {
    wire.push(price);
    if (wire.length === 1) return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 };
    return { accepted: false, reason: RAISE_REFUSED, status: 400, text: RAISE_REFUSED };
  };
}

const state = (remaining) => ({ closesInMs: remaining, myRank: null, minDecrement: 100,
  standingL1Price: null, measuredRttMs: 50 });

async function drive(eng, m, { from = 160_000, maxTicks = 20_000 } = {}) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    let r = from;
    let ticks = 0;
    while (r >= 0 && ticks++ < maxTicks) {
      await eng._maybeBid(m, state(r));
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
}

function detach(m) { if (m && m.timer) { clearTimeout(m.timer); m.timer = null; } return m; }

(async () => {
  const engine = new BidEngine(adapter, new DurableScheduler(file), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: { enabled: false },
    onEvent: () => {},
  });
  const requests = new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 });
  const load = { id: 'RA1', lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
    companyName: 'Durian Industries', closesAt: Date.now() + 600_000, startsAt: Date.now() - 1000, status: 'live', softClose: false };
  const created = await requests.createForLoad(load, { deadlineAt: Date.now() + 300_000 });
  const captured = await requests.capture(created.id, { cost: 45_000 });

  landFirstThenRefuse();
  const m1 = detach(armFromRequest(engine, captured));
  await drive(engine, m1);

  await check('control: the first price landed and the portal then refused a raise', async () => {
    assert.strictEqual(wire.length >= 2, true, `only ${wire.length} write(s) went out`);
    assert.strictEqual(m1.priceRaiseRefused, true, 'the raise refusal never latched, so there is nothing to carry');
  });

  engine.stop('RA1');
  engine.scheduler.update('RA1', { status: 'stopped' });
  await requests.stop(created.id);
  const rearmed = await requests.rearm(created.id);
  const before = wire.length;
  const m2 = detach(armFromRequest(engine, rearmed));

  await check('a desk re-arm does not carry the raise refusal onto the load it re-arms', async () => {
    assert.strictEqual(m2.priceRaiseRefused, false,
      `Re-arm brought the load back already stood down on the old raise refusal (epoch ${rearmed.repriceEpoch}, `
      + `intent ${JSON.stringify(engine.scheduler.get('RA1').repriceEpoch)}): it will not bid and nothing new is said`);
  });

  await check('a re-arm still never re-spends the landed rung', async () => {
    assert.ok(m2.firedRungs.has(0), `the landed rung 0 is not in the re-armed monitor's spent set ${JSON.stringify([...m2.firedRungs])}`);
  });

  await check('the re-armed load puts a write on the wire again', async () => {
    await drive(engine, m2);
    const after = wire.slice(before);
    assert.ok(after.length >= 1, 'the re-armed load sent nothing: the desk pressed Re-arm and the bot stayed silent');
    assert.ok(!after.includes(wire[0]), `the re-armed load re-sent the price that already stands (${wire[0]})`);
  });
  engine.kill();
})().catch((e) => { console.error(e); process.exitCode = 1; });
