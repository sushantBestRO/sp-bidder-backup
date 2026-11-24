'use strict';
/**
 * The restart banner must count what actually came back, not what was on disk.
 *
 * THE DEFECT. rehydrate() emitted "resumed N live auction(s)" with N = activeIntents().length, and
 * returned the same number, BEFORE the loop below it retired an unknown share of them. The count
 * applies no close-time test at all - which is the exact fault the writes-off branch was repaired
 * for - but the repair landed only there, while this method serves the write-enabled GoComet path
 * and every SuperProcure stack. On the boot this branch was written for that reads "resumed 52 live
 * auction(s)" while all 52 retire and nothing re-arms: the operator believes 52 auctions are being
 * bid and hand-quotes none of them. server.js folds the return value into the boot banner, so the
 * log line carries the same wrong number.
 *
 *   A. past-close intents are retired and EXCLUDED from the resumed count, and the notice says how
 *      many were retired rather than implying they came back.
 *   B. a boot where everything really is live still reports every one of them, and the notice
 *      carries no retirement clause it did not earn.
 *
 *   node scripts/test-rehydrate-resume-count.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intents files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const HOUR = 3_600_000;
const dirs = [];

/** Reads never come back, so a re-armed monitor just retries - nothing finalizes behind the test. */
const adapter = {
  capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'soft' }),
  ensureSession: async () => ({}),
  writeEnabled: false,
  async getAuctionState() { return { ok: false, error: 'ECONNRESET' }; },
  async placeBid() { throw new Error('placeBid must never be reached in this test'); },
};

/** An intent in the shape an armed-and-never-finalized load leaves on disk. */
const intent = (id, closesAt) => ({
  auctionId: id, status: 'bidding', closesAt,
  lane: { origin: 'Bhiwandi', destination: 'Hosur' }, equipment: '32ft SXL', units: 1,
  companyName: 'Waaree Energies', cost: 50_000, marginsPct: [12.6, 7.2, 6.3],
  firedRungs: [0], revisionsLeft: 2, createdAt: Date.now() - HOUR,
});

function engineWith(tag, intents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `resume-${tag}-`));
  dirs.push(dir);
  const file = path.join(dir, 'intents.json');
  fs.writeFileSync(file, JSON.stringify({ savedAt: Date.now(), intents }));
  const events = [];
  const eng = new BidEngine(adapter, new DurableScheduler(file), {
    onEvent: (e) => { if (e.type === 'alert') events.push(e); },
  });
  return { eng, events };
}

const noticeIn = (events) => events.find((e) => e.kind === 'restart_with_live_auctions');

(async () => {
  // ---- A. two dead, one live ----
  {
    const { eng, events } = engineWith('mixed', [
      intent('DEAD-1', Date.now() - 2 * HOUR),
      intent('DEAD-2', Date.now() - 3 * HOUR),
      intent('LIVE-1', Date.now() + 2 * HOUR),
    ]);
    const n = await eng.rehydrate();
    ok(n === 1, `A: rehydrate returns what actually resumed, not the raw intent count (got ${n})`);

    const notice = noticeIn(events);
    ok(!!notice, 'A: the restart is still announced');
    ok(!!notice && notice.count === 1, `A: ...counting only the auctions that came back (got ${notice && notice.count})`);
    ok(!!notice && /resumed 1 live auction/.test(notice.message),
      `A: ...and saying so in the message the console shows (got "${notice && notice.message}")`);
    ok(!!notice && /2/.test(notice.message) && /retired|already ended/.test(notice.message),
      `A: the two that had already ended are named as retired, never implied to be running (got "${notice && notice.message}")`);
    ok(eng.monitors.has('LIVE-1') && !eng.monitors.has('DEAD-1') && !eng.monitors.has('DEAD-2'),
      'A: and only the live one is actually armed');
    ok(eng.scheduler.get('DEAD-1').status === 'closed' && eng.scheduler.get('DEAD-2').status === 'closed',
      'A: the dead ones are retired by the same sweep, not merely skipped');
    eng.kill();
  }

  // ---- B. everything genuinely live ----
  // Guards the guard: a count that always shrank, or a message that always claimed retirements,
  // would satisfy block A on its own.
  {
    const { eng, events } = engineWith('live', [
      intent('L1', Date.now() + 2 * HOUR),
      intent('L2', Date.now() + 3 * HOUR),
    ]);
    const n = await eng.rehydrate();
    ok(n === 2, `B: a boot where nothing had ended resumes all of them (got ${n})`);
    const notice = noticeIn(events);
    ok(!!notice && notice.count === 2 && /resumed 2 live auction/.test(notice.message),
      `B: ...and the notice says two (got "${notice && notice.message}")`);
    ok(!!notice && !/retired/.test(notice.message),
      `B: with no retirement clause it did not earn (got "${notice && notice.message}")`);
    eng.kill();
  }

  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }

  const EXPECTED_CHECKS = 10;
  assert.strictEqual(fail, 0, `${fail} rehydrate resume-count checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
