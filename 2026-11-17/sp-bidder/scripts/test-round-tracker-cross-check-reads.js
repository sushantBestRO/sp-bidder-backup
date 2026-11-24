'use strict';
/**
 * The adapter reads the round tracker's cross-checks stand on (round-tracker spec s1.5 row 7, s5.1, s6
 * piece B; map s4 tests 6, 10 and 13).
 *
 *   1  SuperProcure: the state read publishes the close the last listing parsed and when that listing
 *      landed (restClosesAtMs / restSeenAt), so the tracker can compare it with the socket's.
 *   2  SuperProcure: after a listingProbe, listedCloseAt names the close that listing parsed - the
 *      probe's own envelope is a pinned key set and carries only SuperProcure's raw string.
 *   3  GoComet: closeProbe reads the enquiry detail FRESH even when a cached detail exists (the cache
 *      holds the close being asked about), and answers the parsed close, open/closed and our rank.
 *
 * The real adapters over a stubbed transport; nothing reaches the network.
 *
 *   node scripts/test-round-tracker-cross-check-reads.js
 */
const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');

const EXPECTED_CHECKS = 3;
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

function listingRow(id, closeIso) {
  return {
    id, loadCode: `BRL-${id}`, companyName: 'Havells India Ltd.', branchName: 'Alwar Cable (1350)', biddingOn: 1,
    loadingPoints: JSON.stringify([{ pin: '572138', shortName: 'TUMKURU', isLoadingPoint: 1 },
      { pin: '606111', shortName: 'CUDDALORE', isLoadingPoint: 0 }]),
    biddingStartTime: new Date(Date.now() - 60_000).toISOString(), biddingCloseTime: closeIso,
    branchAuctionExtendTime: '00:02:00', branchExtendAuctionCount: 3, branchBidCountAllowed: 30,
    loadShipmentType: 'FTL', branchQuoteType: 'FTL', vehicleCount: 1, isOpenAuction: 0,
    loadStatusKey: 'OPEN', loadNotificationStatus: 'START', oldLoadId: null,
  };
}

function spAdapter(closeIso) {
  const fetchImpl = async (url) => {
    if (String(url).includes('/sp/loads/v4')) return resp(200, { data: { loadDetails: [listingRow(23090881, closeIso())] } });
    throw new Error(`unexpected request ${url}`);
  };
  const a = new RealSuperProcureAdapter({ token: 'cross-check-test-token', fetchImpl });
  a.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000, branchIds: [956055] };
  return a;
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const validToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1' })}.sig`;

const results = [];
async function check(name, fn) {
  let failure = null;
  try { await fn(); } catch (e) { failure = (e && e.message) || String(e); }
  results.push({ name, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${name} [red]`);
  if (failure) console.log(`        ${failure.split('\n')[0]}`);
}

(async () => {
  const title = 'Round tracker piece B: the adapter reads behind the cross-checks';
  console.log(`${title}\n`);

  await check('1 SP: the state read carries the listing\'s parsed close and when that listing landed', async () => {
    const close = Date.now() + 600_000;
    const a = spAdapter(() => new Date(close).toISOString());
    const before = Date.now();
    await a.listAuctions();
    const st = await a.getAuctionState(23090881);
    assert.ok(st && st.ok, `HARNESS: the state read failed ${JSON.stringify(st)}`);
    assert.strictEqual(st.restClosesAtMs, close,
      `restClosesAtMs is ${st.restClosesAtMs}, expected the listing's close ${close}: the listing's close is cached but not published`);
    assert.ok(Number.isFinite(st.restSeenAt) && st.restSeenAt >= before,
      `restSeenAt is ${st.restSeenAt}, expected when the listing landed (>= ${before})`);
  });

  await check('2 SP: listedCloseAt names the close the probe\'s listing parsed', async () => {
    let close = Date.now() + 600_000;
    const a = spAdapter(() => new Date(close).toISOString());
    await a.listAuctions();
    close += 120_000;
    const probe = await a.listingProbe(23090881);
    assert.strictEqual(probe.stillListed, true, `HARNESS: the probe did not find the load ${JSON.stringify(probe)}`);
    assert.strictEqual(typeof a.listedCloseAt, 'function', 'the adapter exposes no listedCloseAt(auctionId)');
    assert.strictEqual(a.listedCloseAt(23090881), close, `listedCloseAt is ${a.listedCloseAt(23090881)}, expected ${close}`);
    assert.strictEqual(a.listedCloseAt(1), null, 'a load no listing showed has no listed close');
  });

  await check('3 GoComet: closeProbe reads the detail fresh past the cache and answers close, status and rank', async () => {
    const key = 'GCX-1';
    let close = Date.now() + 300_000;
    let detailGets = 0;
    const detail = () => ({ data: { cargo_quantity: 1, slab_rate: 500, bid_close_timestamp: new Date(close).toISOString(),
      bid_closing_in: null, bidding_closed: false, vendor_rank: 2 } });
    const fetchImpl = async (url) => {
      if (String(url).endsWith(`/api/v1/vendor/enquiries/${key}`)) { detailGets += 1; return resp(200, detail()); }
      throw new Error(`unexpected request ${url}`);
    };
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: async () => {}, log: quiet });
    await a.refreshLoadRules(key);
    if (detailGets !== 1) throw new Error(`HARNESS: the first detail read made ${detailGets} request(s)`);
    close += 299_000;
    assert.strictEqual(typeof a.closeProbe, 'function', 'the GoComet adapter exposes no closeProbe(auctionId)');
    const r = await a.closeProbe(key);
    assert.strictEqual(detailGets, 2, `closeProbe made ${detailGets - 1} detail request(s): a cached detail answered the old close`);
    assert.deepStrictEqual(r, { closesAtMs: close, status: 'open', vendorRank: 2 }, `closeProbe answered ${JSON.stringify(r)}`);
  });

  const failed = results.filter((r) => r.failure);
  if (results.length !== EXPECTED_CHECKS || failed.length) {
    console.log(`\nFAIL - ${results.length - failed.length}/${EXPECTED_CHECKS} checks passed (${results.length} ran): ${title}`);
    process.exitCode = 1;
  } else console.log(`\nPASS - ${EXPECTED_CHECKS} checks: ${title}`);
})().catch((e) => { console.error(`\nFAIL - harness threw: ${(e && e.stack) || e}`); process.exitCode = 1; });
