'use strict';
/**
 * S2002: a SuperProcure listing read that did not succeed is a failed read, never an empty board.
 *
 * realAdapter.listAuctions threw only on 401/403. A transport failure (status 0), a 429/503 still
 * failing after the retries, any other non-2xx, or a 2xx whose body is not the listing JSON fell
 * through to [] - so the adapter stamped lastFullListingAt, reset the read streak, and listingProbe
 * answered stillListed:false, byte-identical to a genuine delist. The never-listed check then told
 * the desk a load was not open at arm, and discovery kept the dead-man's-switch ping green through
 * a sustained listing outage.
 *
 *   node scripts/test-sp-failed-listing-is-not-an-empty-board.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { DiscoveryPoller } = require('../src/discovery/discovery');
const { createStore } = require('../src/store');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { Notifier } = require('../src/notify/notifier');

const CLEAN = [];
process.on('exit', () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } });
let seq = 0;
const tmp = () => {
  const f = path.join(os.tmpdir(), `sp-failed-listing-${process.pid}-${seq++}.json`);
  CLEAN.push(f, f + '.tmp');
  return f;
};

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(true); console.log(`  ok  ${name}`); }
  catch (e) { results.push(false); console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const text = (status, body) => ({ status, headers: { get: () => null }, text: async () => body });
const FAILURES = {
  'transport failure (status 0 after retries)': () => { throw new Error('ECONNRESET'); },
  '503 still failing after retries': () => text(503, 'Service Unavailable'),
  '429 still failing after retries': () => text(429, '{"message":"slow down"}'),
  '500 with an HTML body': () => text(500, '<html>Bad Gateway</html>'),
  '404': () => text(404, '{"message":"not found"}'),
  '200 with an HTML body': () => text(200, '<html>maintenance</html>'),
  '200 JSON with no loadDetails': () => text(200, JSON.stringify({ data: { message: 'ok' } })),
  '200 JSON whose loadDetails is not an array': () => text(200, JSON.stringify({ data: { loadDetails: null } })),
};

function mkAdapter(respond) {
  const calls = { list: 0 };
  const fetchImpl = async (url) => {
    if (!String(url).includes('/sp/loads/v4')) throw new Error('unexpected request: ' + url);
    calls.list += 1;
    return respond();
  };
  const adapter = new RealSuperProcureAdapter({ token: 's2002-token', fetchImpl, sleep: async () => {}, rand: () => 0 });
  adapter.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000, branchIds: [956055] };
  adapter.writeEnabled = true;
  return { adapter, calls };
}

(async () => {
  for (const [label, respond] of Object.entries(FAILURES)) {
    const { adapter } = mkAdapter(respond);
    adapter._readStreak = 1;
    adapter._lastReadFailureAt = 12345;

    await check(`${label}: listAuctions rejects instead of returning an empty board`, async () => {
      let threw = null;
      let got;
      try { got = await adapter.listAuctions(); } catch (e) { threw = e; }
      assert.ok(threw, `expected a failed read, got ${JSON.stringify(got)}`);
      assert.notStrictEqual(threw.code, 'AUTH', 'a non-auth failure must not be coded AUTH');
    });
    await check(`${label}: the full-listing time is not stamped`, async () => {
      assert.strictEqual(adapter.lastFullListingAt(), null);
    });
    await check(`${label}: the read streak is not reset as a read success`, async () => {
      assert.strictEqual(adapter._readStreak, 1);
      assert.strictEqual(adapter._lastReadFailureAt, 12345);
    });
    await check(`${label}: listingProbe answers UNKNOWN, not stillListed false`, async () => {
      const p = await adapter.listingProbe('L1');
      assert.strictEqual(p.stillListed, null, `stillListed=${p.stillListed}`);
      assert.strictEqual(p.listedCount, null, `listedCount=${p.listedCount}`);
      assert.ok(p.error, 'the probe must carry the failure');
    });
  }

  await check('control: a 200 with an empty loadDetails array is a real empty board', async () => {
    const { adapter } = mkAdapter(() => text(200, JSON.stringify({ data: { loadDetails: [] } })));
    adapter._readStreak = 1;
    const got = await adapter.listAuctions();
    assert.deepStrictEqual(got, []);
    assert.ok(adapter.lastFullListingAt() != null, 'a real listing stamps lastFullListingAt');
    assert.strictEqual(adapter._readStreak, 0, 'a real listing is a read success');
    const p = await adapter.listingProbe('L1');
    assert.strictEqual(p.stillListed, false);
    assert.strictEqual(p.listedCount, 0);
  });

  await check('control: a 401 still throws AUTH', async () => {
    const { adapter } = mkAdapter(() => text(401, '{"message":"unauthorized"}'));
    let threw = null;
    try { await adapter.listAuctions(); } catch (e) { threw = e; }
    assert.ok(threw && threw.code === 'AUTH');
  });

  // Engine path (B049): a never-listed load armed, then the only listing after arm FAILED. That is
  // no evidence about the load, so the desk must not be told it is not open.
  {
    const { adapter } = mkAdapter(FAILURES['503 still failing after retries']);
    const events = [];
    const engine = new BidEngine(adapter, new DurableScheduler(tmp()), {
      config: { openAtMs: 60_000, floorWindowMs: 2_500, minInterFireMs: 0, neverListedProbeBoundMs: 0 },
      live: true, onEvent: (e) => events.push(e), log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const m = engine.arm({
      id: 'NL-FAILED', lane: { origin: 'Bagru', destination: 'Badli' }, equipment: '32FT', units: 1,
      companyName: 'BG', closesAt: Date.now() + 120_000, startsAt: Date.now() - 1_000, status: 'live', softClose: false,
    }, { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 });
    if (m.timer) clearTimeout(m.timer);
    m.timer = null;
    try { await adapter.listAuctions(); } catch (_) {}
    engine._checkDelisted(m);
    await new Promise((r) => setTimeout(r, 50));
    await check('engine: a failed listing after arm does not mark a never-listed load not open', async () => {
      const notices = events.filter((e) => e.kind === 'load_not_biddable');
      assert.strictEqual(notices.length, 0, `got ${notices.length} load_not_biddable notice(s)`);
      assert.ok(!m._notOpenAtArm, 'the close would carry not_open_on_portal');
    });
    engine.kill('done');
  }

  // Discovery (D003): a failed listing must not look like a good tick to the dead-man's switch.
  {
    const { adapter } = mkAdapter(FAILURES['503 still failing after retries']);
    const pings = [];
    const s = createStore({ backend: 'memory' });
    const poller = new DiscoveryPoller({
      adapter, requests: new PriceRequestStore({ store: s, marginsPct: [10], minMarginPct: 5 }),
      notifier: new Notifier({ mode: 'dashboard', baseUrl: 'http://t' }),
      config: { allowlist: { shippers: ['Havells'] }, priceDeadlineLeadMs: 90_000 },
      healthcheckUrl: 'http://hc.test/ping', healthcheckFetch: async (u) => { pings.push(u); return { ok: true }; },
    });
    await poller.tick();
    await check('discovery: a failed SuperProcure listing does not stamp a good tick or ping the dead-man switch', async () => {
      assert.strictEqual(poller._lastGoodTickAt == null, true, `_lastGoodTickAt=${poller._lastGoodTickAt}`);
      assert.strictEqual(pings.length, 0, `pinged ${pings.length} time(s)`);
    });
  }

  const failed = results.filter((r) => !r).length;
  if (failed) {
    console.log(`FAIL - ${failed} of ${results.length} checks: a failed SuperProcure listing reads as an empty board`);
    process.exit(1);
  }
  console.log(`PASS - ${results.length} checks: a failed SuperProcure listing surfaces as a failed read`);
})().catch((e) => { console.log(`FAIL - harness: ${e && e.stack}`); process.exit(1); });
