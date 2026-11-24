'use strict';
/**
 * ONE DURABLE HOME PER SPENT RUNG - the carried refusals never repeat what firedRungs already holds.
 *
 * The intent keeps two records of which rungs are spent. firedRungs is written at the LANDED sites
 * and is what every re-arm path restores (and what priorLandedBidPrice reads as the bid that stands).
 * refusalState.offeredRungs carries the rungs the portal REFUSED after the last landed write, which
 * firedRungs never sees. When offeredRungs also repeated the landed rungs, the same fact lived in two
 * places with different lifetimes: firedRungs is remapped across a re-price, offeredRungs is dropped
 * by the epoch, so the two copies disagree on exactly the path where a spent rung matters most.
 *
 * WHAT MUST NOT MOVE: a restart still re-offers no price the portal refused and never re-offers the
 * landed one (checks 3-4). Losing the landed rung from offeredRungs is only safe because firedRungs
 * carries it, and check 4 is what proves the restart still reads it there.
 *
 *   node scripts/test-refusal-state-no-second-home.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let ran = 0, pass = 0;
const FAILURES = [];
const check = async (name, fn) => {
  ran++;
  try { await fn(); console.log('  ok  ' + name); pass++; }
  catch (e) { FAILURES.push({ name, message: (e && e.message) ? e.message : String(e) }); console.log('  FAIL  ' + name); }
};
const EXPECTED_CHECKS = 4;
process.on('exit', () => {
  const bad = [];
  if (ran !== EXPECTED_CHECKS) bad.push(`only ${ran} of ${EXPECTED_CHECKS} checks ran - this file exited early`);
  if (pass !== EXPECTED_CHECKS) bad.push(`${EXPECTED_CHECKS - pass} of ${EXPECTED_CHECKS} checks failed`);
  if (!bad.length) { console.log(`\nrefusal state, one home per rung: ${pass}/${EXPECTED_CHECKS} checks passed`); return; }
  console.error(`\nCOMPLETION SENTINEL FAILED: ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `refusal-home-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
process.on('exit', () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } });

const ID = 'HOME-1';
const META = { id: ID, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1, equipment: '32ft',
  companyName: 'Havells', branchName: 'Alwar Cable', closesAt: Date.now() + 600_000 };
const INPUTS = { cost: 100_000, marginsPct: [15, 12, 9, 6, 3] };
const LADDER = [115_000, 112_000, 109_000, 106_000, 103_000];
// SuperProcure's numeric cap AT the floor: the residual price class, so no terminal latch fires and
// only the carried spend can stop a re-send.
const CAP_AT_FLOOR = `Amount is invalid. Amount should be less than or equal to ${LADDER[LADDER.length - 1]}`;

function mkEngine(file) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 5, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
  };
  return new BidEngine(adapter, new DurableScheduler(file), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: { enabled: false },
    onEvent: () => {},
  });
}

// The first write lands; every later one is refused at the cap.
function landFirstThenRefuse(eng) {
  const box = { attempted: [], landed: [] };
  eng.adapter.placeBid = async (_id, price) => {
    box.attempted.push(price);
    if (!box.landed.length) { box.landed.push(price); return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }; }
    return { accepted: false, reason: CAP_AT_FLOOR, status: 400, text: CAP_AT_FLOOR };
  };
  return box;
}

function refuseAll(eng) {
  const box = { attempted: [] };
  eng.adapter.placeBid = async (_id, price) => {
    box.attempted.push(price);
    return { accepted: false, reason: CAP_AT_FLOOR, status: 400, text: CAP_AT_FLOOR };
  };
  return box;
}

const state = (remaining) => ({ closesInMs: remaining, myRank: null, minDecrement: 100,
  standingL1Price: null, measuredRttMs: 50 });

async function drive(eng, m, { from = 160_000, to = 0, maxTicks = 20_000 } = {}) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    let r = from;
    let ticks = 0;
    while (r >= to && ticks++ < maxTicks) {
      await eng._maybeBid(m, state(r));
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
}

function detach(m) { if (m && m.timer) { clearTimeout(m.timer); m.timer = null; } return m; }
const onDisk = (file) => new DurableScheduler(file).get(ID) || {};

(async () => {
  // One lifetime shared by checks 1-4: rung 0 lands, the rest of the ladder is refused.
  const file = tmp();
  const eng1 = mkEngine(file);
  const box1 = landFirstThenRefuse(eng1);
  const m1 = detach(eng1.arm(META, INPUTS));
  assert.deepStrictEqual(m1.ladder, LADDER, `the band derivation moved: armed ladder ${JSON.stringify(m1.ladder)}`);
  await drive(eng1, m1);

  await check('control: the first write landed and the rest were refused', async () => {
    assert.deepStrictEqual(box1.landed, [LADDER[0]], `landed ${JSON.stringify(box1.landed)}`);
    assert.ok(box1.attempted.length >= 2, `only ${box1.attempted.length} write(s) went out; nothing was refused`);
    const it = onDisk(file);
    assert.ok(Array.isArray(it.firedRungs) && it.firedRungs.includes(0),
      `the landed rung is not on the durable firedRungs (${JSON.stringify(it.firedRungs)})`);
    assert.ok(it.refusalState, 'no refusalState reached disk, so the checks below measure nothing');
  });

  await check('offeredRungs repeats no rung the durable firedRungs already holds', async () => {
    const it = onDisk(file);
    const onRecord = new Set(it.firedRungs || []);
    const twice = ((it.refusalState && it.refusalState.offeredRungs) || []).filter((i) => onRecord.has(i));
    assert.deepStrictEqual(twice, [],
      `rung(s) ${JSON.stringify(twice)} are stored as spent in both firedRungs ${JSON.stringify(it.firedRungs)} `
      + `and refusalState.offeredRungs ${JSON.stringify(it.refusalState.offeredRungs)}`);
  });

  const eng2 = mkEngine(file);
  const box2 = refuseAll(eng2);
  await eng2.rehydrate();
  const m2 = eng2.monitors.get(ID);
  if (m2) { detach(m2); await drive(eng2, m2); }

  await check('a restart never re-offers the landed rung', async () => {
    assert.ok(m2, 'rehydrate() did not re-arm the load');
    assert.ok(!box2.attempted.includes(LADDER[0]),
      `the restart re-offered the price that already stands (${LADDER[0]}): [${box2.attempted.join(', ')}]`);
  });

  await check('a restart re-offers no price the portal refused', async () => {
    const refused = box1.attempted.filter((p) => !box1.landed.includes(p));
    const resent = box2.attempted.filter((p) => refused.includes(p));
    assert.deepStrictEqual(resent, [], `refused prices re-sent after the restart: [${resent.join(', ')}]`);
  });
})().catch((e) => { console.error(e); process.exitCode = 1; });
