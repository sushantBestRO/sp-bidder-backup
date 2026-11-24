'use strict';
/**
 * M1: a discarded rung never reports a negative gap.
 *
 * The min-decrement guard in _maybeBid sits above the standing-bid belt, so a non-floor decision at
 * or above our own standing bid reaches _recordRungDiscard first. It computed
 * gap = lastBidPrice - price and printed "Rs 19296 is only Rs -696 below our own last bid of
 * Rs 18600" into the alert's detail. The standing bid drops under the successor's next rung when a
 * write banked after a re-price (_recordLandedAfterRetire) lowers the live monitor's lastBidPrice.
 *
 *   node scripts/test-rung-discard-never-negative-gap.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intents file), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

async function run(standingAfterEstablish) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rung-discard-'));
  const events = [];
  const placed = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    writeEnabled: true,
    async getAuctionState() {
      return { ok: true, status: 'live', myRank: placed.length ? 2 : null, totalBidders: 2, standingL1Price: null,
        closesInMs: 30_000, revisionLimit: 3, revisionsLeft: null, minDecrement: 1500, closeModel: 'hard', measuredRttMs: 50 };
    },
    async placeBid(id, price) { placed.push(price); return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }; },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(path.join(dir, 'intents.json')),
    { config: { openAtMs: 60_000, floorWindowMs: 2_500, minInterFireMs: 0 }, rand: () => 0,
      onEvent: (e) => events.push(e) });
  const m = eng.arm({ id: 'G1', lane: { origin: 'A', destination: 'B' }, units: 1, companyName: 'Havells',
    closesAt: Date.now() + 30_000 }, { cost: 18_000, marginsPct: [12.6, 7.2, 2.7], minMarginPct: 2.7 });
  await eng._tick(m); if (m.timer) clearTimeout(m.timer);
  if (standingAfterEstablish != null) m.lastBidPrice = standingAfterEstablish;
  await eng._tick(m); if (m.timer) clearTimeout(m.timer);
  eng.kill();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  const alert = events.find((e) => e.type === 'alert' && e.kind === 'rung_discarded_min_decrement');
  const record = events.find((e) => e.type === 'rung_discarded');
  return { m, placed, alert, record };
}

(async () => {
  console.log('\n1. the standing bid sits under the next rung (a late-banked write lowered it)');
  {
    const { placed, alert, record } = await run(18_600);
    ok(!!alert && alert.price === 19_296 && alert.lastBidPrice === 18_600,
      `fixture: rung 19,296 is discarded against a standing 18,600 (${alert && alert.detail})`);
    ok(!/Rs -|-\d/.test(alert ? alert.detail : ''), 'the alert detail carries no negative figure');
    ok(/Rs 19296 is not below our own last bid of Rs 18600/.test(alert ? alert.detail : ''),
      'it says the price is not below our standing bid');
    ok(alert && !(Number(alert.gap) < 0) && record && !(Number(record.gap) < 0),
      `neither the alert nor the durable record carries a negative gap (alert ${alert && alert.gap}, record ${record && record.gap})`);
    ok(!placed.includes(19_296), 'the price never went on the wire');
  }

  console.log('\n2. an ordinary too-close step reads as before');
  {
    const { alert, record } = await run(null);
    ok(!!alert && alert.gap === 972 && record.gap === 972
      && /Rs 19296 is only Rs 972 below our own last bid of Rs 20268/.test(alert.detail),
      `a 972 step under a 1,500 minimum keeps its gap and wording (${alert && alert.detail})`);
  }

  const EXPECTED_CHECKS = 6;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (pass + fail !== EXPECTED_CHECKS) {
    console.error(`FAIL - expected ${EXPECTED_CHECKS} checks to run, got ${pass + fail}`);
    process.exit(1);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL -', e && e.stack || e); process.exit(1); });
