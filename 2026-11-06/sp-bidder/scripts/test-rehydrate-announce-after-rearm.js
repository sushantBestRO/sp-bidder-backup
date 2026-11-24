'use strict';
/**
 * T2 D8: the restart notice counts the auctions that actually resumed.
 *
 * rehydrate() emitted "resumed N live auction(s)" before its re-arm loop ran, so a load whose
 * re-arm threw (and raised its own rehydrate_arm_failed alert) was still counted as resumed. The
 * return value already subtracted it; the notice the desk reads did not, and the two disagreed.
 *
 *   node scripts/test-rehydrate-announce-after-rearm.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intents files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

const HOUR = 3_600_000;
const dirs = [];
const adapter = {
  capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'soft' }),
  ensureSession: async () => ({}),
  writeEnabled: false,
  async getAuctionState() { return { ok: false, error: 'ECONNRESET' }; },
  async placeBid() { throw new Error('placeBid must never be reached in this test'); },
};

const intent = (id, extra) => Object.assign({
  auctionId: id, status: 'bidding', closesAt: Date.now() + 2 * HOUR,
  lane: { origin: 'Bhiwandi', destination: 'Hosur' }, equipment: '32ft SXL', units: 1,
  companyName: 'Waaree Energies', cost: 50_000, marginsPct: [12.6, 7.2, 6.3],
  firedRungs: [0], revisionsLeft: 2, createdAt: Date.now() - HOUR,
}, extra || {});

async function boot(tag, intents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `announce-${tag}-`));
  dirs.push(dir);
  const file = path.join(dir, 'intents.json');
  fs.writeFileSync(file, JSON.stringify({ savedAt: Date.now(), intents }));
  const events = [];
  const eng = new BidEngine(adapter, new DurableScheduler(file), {
    onEvent: (e) => { if (e.type === 'alert') events.push(e); },
  });
  const n = await eng.rehydrate();
  const notice = events.find((e) => e.kind === 'restart_with_live_auctions');
  const failed = events.filter((e) => e.kind === 'rehydrate_arm_failed').map((e) => e.auctionId);
  const armed = eng.monitors.size;
  eng.kill();
  return { n, notice, failed, armed };
}

(async () => {
  console.log('\n1. one of two live loads cannot be re-armed (its stored band is empty)');
  {
    const { n, notice, failed, armed } = await boot('mixed', [intent('OK-1'), intent('BAD-1', { marginsPct: [] })]);
    ok(armed === 1 && JSON.stringify(failed) === '["BAD-1"]' && n === 1,
      `fixture: one armed, BAD-1 raised its own alert, rehydrate returned ${n}`);
    ok(!!notice && notice.count === 1, `the notice counts the one that came back (got ${notice && notice.count})`);
    ok(!!notice && /^resumed 1 live auction/.test(notice.message),
      `and says so (got "${notice && notice.message}")`);
  }

  console.log('\n2. nothing could be re-armed');
  {
    const { n, notice } = await boot('none', [intent('BAD-2', { marginsPct: [] })]);
    ok(n === 0 && !!notice && notice.count === 0 && /^resumed 0 live auction/.test(notice.message),
      `the notice claims no resumed auction (got "${notice && notice.message}")`);
  }

  console.log('\n3. every load re-arms');
  {
    const { n, notice } = await boot('all', [intent('L1'), intent('L2')]);
    ok(n === 2 && !!notice && notice.count === 2 && notice.message === 'resumed 2 live auction(s)',
      `the notice is unchanged (got "${notice && notice.message}")`);
  }

  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  const EXPECTED_CHECKS = 5;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (pass + fail !== EXPECTED_CHECKS) {
    console.error(`FAIL - expected ${EXPECTED_CHECKS} checks to run, got ${pass + fail}`);
    process.exit(1);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL -', e && e.stack || e); process.exit(1); });
