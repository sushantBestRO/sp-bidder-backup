'use strict';
/**
 * A CARRIED REFUSAL KEEPS THE LATCHES THAT SHAPE IT - a restart may not turn a clearable latch into a
 * permanent one, or a held price into an offered one.
 *
 * The portal's refusals ride the intent across a restart (refusalState). Two latches decide what those
 * refusals mean, and both live on the monitor:
 *   - submissionClosed clears when a published close moves past the close in force when it latched.
 *     Restored without that close, the latch has nothing to compare against and never clears, so a
 *     load the portal re-opened with an extension sits silent until it closes.
 *   - a tight refused-price bound (a stated budget of 3 or less) stays tight when a later frame
 *     arrives without its cap. Restored without it, the carried run is measured against the shipped
 *     bound of 3 and a price the desk was told is held goes back on the wire.
 *
 * Each case is one real restart: a fresh BidEngine and DurableScheduler over the same intents file,
 * resumed through rehydrate(). Only the adapter is faked.
 *
 *   node scripts/test-refusal-carry-keeps-pr2-latches.js
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
  if (!bad.length) { console.log(`\ncarried refusal keeps its latches: ${pass}/${EXPECTED_CHECKS} checks passed`); return; }
  console.error(`\nCOMPLETION SENTINEL FAILED: ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `refusal-latches-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
process.on('exit', () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } });

const ID = 'LATCH-1';
const CLOSES_AT = Date.now() + 600_000;
const META = { id: ID, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1, equipment: '32ft',
  companyName: 'Havells', branchName: 'Alwar Cable', closesAt: CLOSES_AT };
const INPUTS = { cost: 100_000, marginsPct: [12, 7, 2] };
const LADDER = [112_000, 107_000, 102_000];
const FLOOR = 102_000;
const ENDED = 'Auction has already ended for this load';
const CAP_AT_FLOOR = `Amount is invalid. Amount should be less than or equal to ${FLOOR}`;
const OMIT = Symbol('omit');

function mkEngine(file) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: null, closeModel: 'unknown' }),
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

function refuseAll(eng, body) {
  const box = { attempted: [] };
  eng.adapter.placeBid = async (_id, price) => {
    box.attempted.push(price);
    return { accepted: false, reason: body, status: 400, text: body };
  };
  return box;
}

const mkState = (remaining, limit) => {
  const s = { closesInMs: remaining, myRank: null, minDecrement: 100, standingL1Price: null, measuredRttMs: 50 };
  if (limit !== OMIT) s.revisionLimit = limit;
  return s;
};

async function drive(eng, m, limit, { from = 160_000, maxTicks = 20_000 } = {}) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    let r = from;
    let ticks = 0;
    while (r >= 0 && ticks++ < maxTicks) {
      await eng._maybeBid(m, mkState(r, limit));
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
}

function detach(m) { if (m && m.timer) { clearTimeout(m.timer); m.timer = null; } return m; }

async function restart(file) {
  const eng = mkEngine(file);
  await eng.rehydrate();
  const m = eng.monitors.get(ID);
  assert.ok(m, 'rehydrate() did not re-arm the load - the restart path under test never ran');
  return { eng, m: detach(m) };
}

(async () => {
  // Lifetime 1 for cases A: the portal says the auction has ended on the first write.
  const fileA = tmp();
  const engA = mkEngine(fileA);
  refuseAll(engA, ENDED);
  const mA = detach(engA.arm(META, INPUTS));
  await drive(engA, mA, 3, { from: 30_000, maxTicks: 50 });
  const latchedAt = mA._submissionClosedAtClose;

  await check('A1. control: the latch set in lifetime 1 comes back set after the restart', async () => {
    assert.strictEqual(mA.submissionClosed, true, 'lifetime 1 never latched submissionClosed');
    assert.ok(latchedAt != null, 'lifetime 1 latched with no close to measure a forward move against');
    const { m } = await restart(fileA);
    assert.strictEqual(m.submissionClosed, true, 'the carried latch did not come back after the restart');
  });

  await check('A2. after a restart, a published close moving forward still clears the latch', async () => {
    const { eng, m } = await restart(fileA);
    eng._clearSubmissionClosedOnForwardMove(m, CLOSES_AT + 300_000);
    assert.strictEqual(m.submissionClosed, false,
      `the portal published a close ${300_000} ms later than the one the latch was set against, and the restored `
      + `latch stayed set (anchor ${m._submissionClosedAtClose}): the load cannot bid again until it closes`);
  });

  // Lifetime 1 for case B: a stated budget of 3 makes the refused-price bound 1; the floor is refused
  // once and held.
  const fileB = tmp();
  const engB = mkEngine(fileB);
  const boxB1 = refuseAll(engB, CAP_AT_FLOOR);
  const mB = detach(engB.arm(META, INPUTS));
  assert.deepStrictEqual(mB.ladder, LADDER, `the band derivation moved: armed ladder ${JSON.stringify(mB.ladder)}`);
  await drive(engB, mB, 3);

  await check('B1. control: lifetime 1 sent the floor once and held it', async () => {
    assert.strictEqual(boxB1.attempted.filter((p) => p === FLOOR).length, 1,
      `lifetime 1 sent the floor ${boxB1.attempted.filter((p) => p === FLOOR).length} times: [${boxB1.attempted.join(', ')}]`);
  });

  await check('B2. after a restart, a frame without its cap does not re-send the held floor', async () => {
    const { eng, m } = await restart(fileB);
    const box = refuseAll(eng, CAP_AT_FLOOR);
    await drive(eng, m, OMIT);
    assert.deepStrictEqual(box.attempted.filter((p) => p === FLOOR), [],
      `the floor the desk was told is held went back on the wire after the restart: [${box.attempted.join(', ')}]. `
      + 'The load had stated a budget of 3; frames without the cap measured the carried run against the shipped bound of 3');
  });
})().catch((e) => { console.error(e); process.exitCode = 1; });
