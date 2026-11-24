'use strict';
/**
 * Regression: Waaree size-mobile, 2026-10-05.
 *
 * Carrier drawer evidence saved at
 * docs/tests/2026-10-05_waaree-size-mobile/runtime/sp-portal-source/
 * shows the native display scalar at loadReference.infoToShow[] titled
 * "Dimensions". The listing tuple is not a display contract and must not be
 * parsed, defaulted, or supplemented from vehicle-master data.
 *
 * This single regression drives the production path: list/detail mapping ->
 * PriceRequestStore -> renderPriceForm -> Notifier._priceNeededData ->
 * renderMessage, and pins the bounded in-memory detail cache.
 *
 * @requires-summary-line
 * node scripts/test-superprocure-load-dimensions.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const path = require('path');
process.env.SP_DATA_DIR = path.resolve(__dirname, '../docs/tests/2026-10-05_waaree-size-mobile/runtime');

const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { MemoryStore } = require('../src/store/memoryStore');
const { Notifier } = require('../src/notify/notifier');
const { renderMessage } = require('../src/notify/waTemplates');
const { renderPriceForm, stacks } = require('../src/web/server');

const NOW = Date.now();
const NATIVE_DIMENSIONS = '7.8 x 4 x 7.8 ft'; // Synthetic display fixture, not a captured size.

function response(status, body) {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

function rawLoad(id, overrides = {}) {
  return Object.assign({
    id,
    loadCode: `CODE-${id}`,
    loadingPoints: JSON.stringify([
      { isLoadingPoint: 1, shortName: 'Surat' },
      { isLoadingPoint: 0, shortName: 'Pune' },
    ]),
    vehicleName: '40ft Trailer',
    vehicleType: 'Trailer',
    vehicleCount: 1,
    weight: 12,
    brancheUnit: 'MT',
    branchQuoteType: 'FTL',
    companyName: 'Dimension regression shipper',
    biddingOn: 1,
    biddingStartTime: new Date(NOW - 60_000).toISOString(),
    biddingCloseTime: new Date(NOW + 60 * 60_000).toISOString(),
    branchAuctionExtendTime: '00:00:00',
  }, overrides);
}

function nativeDetail(loadId, value = NATIVE_DIMENSIONS, idKey = 'loads') {
  return { data: {
    [idKey]: idKey === 'loads' ? { id: loadId } : { loadId },
    loadReference: { infoToShow: [{ title: 'Dimensions', value }] },
  } };
}

function sizeTile(html) {
  const match = /<span class="sl">Size<\/span><span class="sv">([\s\S]*?)<\/span>/.exec(html);
  return match ? match[1] : null;
}

function readyAccount() {
  return { carrierId: 7, branchIds: [11], tokenExp: NOW + 24 * 60 * 60_000 };
}

async function should_display_only_native_carrier_drawer_dimensions_when_pricing_a_superprocure_load() {
  /*
   * Tracker: Waaree size-mobile 2026-10-05. Recorded portal rows contained
   * the native Dimensions display field; current sample 47 is null/zero.
   */
  // Arrange: a raw listing tuple is deliberately present, but is not display data.
  const adapter = new RealSuperProcureAdapter({ token: 'test-token' });
  const mapped = adapter._mapLoad(rawLoad('DIRECT-1', {
    dimensions: '78:40:78', loadDimensionUnit: 'ft', dimensionUnit: 'm', branchDimensions: 1,
  }), nativeDetail('DIRECT-1'));
  const requests = new PriceRequestStore({
    store: new MemoryStore(), marginsPct: [10, 5], minMarginPct: 5,
  });

  // Act: preserve the portal's existing display string across every desk-facing surface.
  const request = await requests.createForLoad(mapped, { deadlineAt: NOW + 55 * 60_000 });
  const html = renderPriceForm({ headers: {}, query: {} }, request, {});
  const data = await new Notifier({ baseUrl: 'http://test.local' })._priceNeededData(request);
  const whatsapp = renderMessage('price_needed', data);

  // Assert: detail wins; the raw tuple and vehicle name cannot invent a Size value.
  assert.strictEqual(mapped.dimensions, NATIVE_DIMENSIONS,
    'realAdapter maps the native carrier-drawer value, rather than parsing the listing tuple');
  assert.strictEqual(request.load.dimensions, NATIVE_DIMENSIONS,
    'PriceRequestStore snapshots the native scalar');
  assert.strictEqual(sizeTile(html), NATIVE_DIMENSIONS,
    'the /price page has one semantic Size tile with the native value');
  assert.ok(whatsapp.includes(`1 x 40ft Trailer . 12 MT . ${NATIVE_DIMENSIONS}`),
    `the WhatsApp price ask carries the same native scalar (got: ${JSON.stringify(whatsapp)})`);
  assert.ok(!html.includes('78:40:78') && !whatsapp.includes('78:40:78'),
    'the raw listing tuple never leaks to a desk-facing renderer');

  // A transient detail failure leaves discovery rows usable, samples no bid-timing RTT, and emits
  // one operator-visible, structured warning rather than creating a desk/UI failure taxonomy.
  const failureErrors = [];
  const originalConsoleError = console.error;
  let failedDetailCalls = 0;
  const failureAdapter = new RealSuperProcureAdapter({
    token: 'test-token',
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      if (init.method === 'POST' && parsed.pathname.endsWith('/sp/loads/v4')) {
        return response(200, { data: { loadDetails: [rawLoad('DETAIL-500', { branchDimensions: 1 })] } });
      }
      failedDetailCalls += 1;
      return response(500, { error: 'detail unavailable' });
    },
  });
  failureAdapter.account = readyAccount();
  const failureRttBefore = failureAdapter._roundTrips.length;
  let failureFirst;
  let failureSecond;
  try {
    console.error = (...args) => failureErrors.push(args.map(String).join(' '));
    failureFirst = await failureAdapter.listAuctions({ enrichDimensions: true });
    failureSecond = await failureAdapter.listAuctions({ enrichDimensions: true });
  } finally {
    console.error = originalConsoleError;
  }
  const failureWarnings = failureErrors.map((line) => { try { return JSON.parse(line); } catch (_) { return null; } });
  assert.strictEqual(failedDetailCalls, 2, 'a failed detail read retries on the next enriched poll');
  assert.strictEqual(failureFirst.length, 1, 'a detail 500 does not discard the discovery row');
  assert.strictEqual(failureSecond.length, 1, 'the next list still returns the discovery row after the detail failure');
  assert.strictEqual(failureFirst[0].dimensions, null, 'a failed detail response supplies no inferred size');
  assert.strictEqual(failureAdapter._roundTrips.length - failureRttBefore, 2,
    'only the two listing responses enter RTT history, never the failed detail read');
  const matchingFailureWarnings = failureWarnings.filter((warning) => warning && warning.level === 'warn'
    && warning.module === 'platform' && warning.loadId === 'DETAIL-500' && warning.status === 500);
  assert.strictEqual(matchingFailureWarnings.length, 1,
    'repeated failures for one load/status key produce one structured platform warning inside five minutes');

  // A first capped poll can create a request before this load receives a detail read. The served
  // page may reconcile a matching live adapter fact, but must never mutate that durable snapshot.
  const refreshAccount = 'dimension-refresh-account';
  const refreshOwner = { accountId: refreshAccount, label: 'SP' };
  const refreshAdapter = new RealSuperProcureAdapter({ token: 'test-token' });
  refreshAdapter.loadMeta.set('REFRESH-1', Object.assign({}, mapped, {
    id: 'REFRESH-1', account: refreshOwner, equipment: '40ft Trailer', dimensions: NATIVE_DIMENSIONS,
  }));
  const storedMissing = await requests.createForLoad(Object.assign({}, mapped, {
    id: 'REFRESH-1', account: refreshOwner, equipment: '40ft Trailer', dimensions: null,
  }), { deadlineAt: NOW + 54 * 60_000 });
  const existingRequest = Object.assign({}, storedMissing, { price: 62_000, capturedAt: NOW - 1_000 });
  const snapshotBefore = {
    dimensions: existingRequest.load.dimensions, closesAt: existingRequest.load.closesAt, price: existingRequest.price,
  };
  const refreshStack = {
    account: { accountId: refreshAccount }, platformKey: 'sp', adapter: refreshAdapter,
    engine: { caps: refreshAdapter.capabilities(), snapshot: () => [] },
  };
  stacks.push(refreshStack);
  try {
    assert.strictEqual(sizeTile(renderPriceForm({ headers: {}, query: {} }, existingRequest, {})), NATIVE_DIMENSIONS,
      'a matching account adapter reconciles a missing stored size at read time');
    const wrongEquipment = Object.assign({}, existingRequest, {
      load: Object.assign({}, existingRequest.load, { equipment: '20ft Box' }),
    });
    assert.strictEqual(sizeTile(renderPriceForm({ headers: {}, query: {} }, wrongEquipment, {})), null,
      'a different stored vehicle cannot inherit this load-meta size');
    const wrongAccount = Object.assign({}, existingRequest, { account: { accountId: 'other-account', label: 'SP' } });
    assert.strictEqual(sizeTile(renderPriceForm({ headers: {}, query: {} }, wrongAccount, {})), null,
      'a request owned by another SuperProcure account cannot read this adapter cache');
    const knownSnapshot = Object.assign({}, existingRequest, {
      load: Object.assign({}, existingRequest.load, { dimensions: 'stored native size' }),
    });
    assert.strictEqual(sizeTile(renderPriceForm({ headers: {}, query: {} }, knownSnapshot, {})), 'stored native size',
      'an existing snapshotted Size is preserved instead of being replaced by fresh adapter metadata');
    assert.deepStrictEqual({
      dimensions: existingRequest.load.dimensions, closesAt: existingRequest.load.closesAt, price: existingRequest.price,
    }, snapshotBefore, 'read-time size reconciliation does not write the durable request or alter its close/price facts');
  } finally {
    const index = stacks.indexOf(refreshStack);
    if (index >= 0) stacks.splice(index, 1);
  }

  // The parser requires attributable, unambiguous native display data and preserves it unchanged.
  const { readSpDimensions } = require('../src/platform/spCargo');
  assert.strictEqual(readSpDimensions(nativeDetail('DIRECT-1'), 'DIRECT-1'), NATIVE_DIMENSIONS,
    'one matching Dimensions row is preserved without unit normalization');
  assert.strictEqual(readSpDimensions(nativeDetail('DIRECT-1', '12 X 8 X 8 FEET', 'loadDetails'), 'DIRECT-1'),
    '12 X 8 X 8 FEET', 'loadDetails.loadId is an equally valid owner key');
  for (const value of ['', '  ', 'N/A', '-', '::', '0 x 0 x 0', '7 x 0 x 8', 12, {}, []]) {
    assert.strictEqual(readSpDimensions(nativeDetail('DIRECT-1', value), 'DIRECT-1'), null,
      `invalid native Dimensions value ${JSON.stringify(value)} is omitted`);
  }
  assert.strictEqual(readSpDimensions({ data: { loads: { id: 'DIRECT-1' }, loadReference: {
    infoToShow: [{ title: 'Dimensions', value: NATIVE_DIMENSIONS }, { title: 'Dimensions', value: '8 x 4 x 8 ft' }],
  } } }, 'DIRECT-1'), null, 'duplicate Dimensions rows are ambiguous and omitted');
  assert.strictEqual(readSpDimensions({ data: { loads: { id: 'DIRECT-1' }, loadDetails: { loadId: 'OTHER-LOAD' }, loadReference: {
    infoToShow: [{ title: 'Dimensions', value: NATIVE_DIMENSIONS }],
  } } }, 'DIRECT-1'), null, 'all present owner ids must agree with the requested load');
  assert.strictEqual(readSpDimensions(nativeDetail('OTHER-LOAD'), 'DIRECT-1'), null,
    'a detail response for another load cannot supply this load\'s size');
  assert.strictEqual(readSpDimensions({ data: { loadReference: { infoToShow: [{ title: 'Dimensions', value: NATIVE_DIMENSIONS }] } } }, 'DIRECT-1'), null,
    'a detail response without an attributable load id is omitted');
  assert.strictEqual(adapter._mapLoad(rawLoad('RAW-ONLY', { dimensions: '78:40:78' })).dimensions, null,
    'a listing tuple without carrier detail is never treated as a Size');

  // Cold-list detail reads are capped, cached in this adapter only, and cannot fail discovery.
  const detailCalls = [];
  const listRows = [
    rawLoad('LIST-1', { branchDimensions: 1 }),
    rawLoad('LIST-2', { dimensions: 'untrusted-listing-text' }),
    rawLoad('LIST-3', { branchDimensions: 1 }),
    rawLoad('LIST-4', { branchDimensions: 1 }),
  ];
  const listAdapter = new RealSuperProcureAdapter({
    token: 'test-token', maxSizeDetailFetchesPerList: 3, sizeDetailTtlMs: 6 * 60 * 60_000,
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      if (init.method === 'POST' && parsed.pathname.endsWith('/sp/loads/v4')) {
        return response(200, { data: { loadDetails: listRows } });
      }
      if (init.method === 'GET' && parsed.pathname.endsWith('/sp/loads/loadBoardDetails')) {
        const id = parsed.searchParams.get('loadId');
        detailCalls.push(id);
        if (id === 'LIST-1') return response(200, nativeDetail(id));
        if (id === 'LIST-2') return response(200, nativeDetail(id, 'N/A'));
        if (id === 'LIST-3') {
          return response(200, nativeDetail(detailCalls.filter((seen) => seen === id).length === 1 ? 'OTHER-LOAD' : id));
        }
        return response(500, { error: 'detail unavailable' });
      }
      throw new Error(`unexpected request ${init.method} ${parsed.pathname}`);
    },
  });
  listAdapter.account = readyAccount();
  const defaultList = await listAdapter.listAuctions();
  assert.strictEqual(detailCalls.length, 0,
    'the default list path performs no carrier-detail reads outside discovery enrichment');
  assert.strictEqual(defaultList.find((load) => load.id === 'LIST-1').dimensions, null,
    'the default list does not revive the raw listing tuple as a Size');

  const rttBefore = listAdapter._roundTrips.length;
  const first = await listAdapter.listAuctions({ enrichDimensions: true });
  const rttAfterFirst = listAdapter._roundTrips.length;
  const second = await listAdapter.listAuctions({ enrichDimensions: true });

  assert.deepStrictEqual(detailCalls.slice(0, 3), ['LIST-1', 'LIST-2', 'LIST-3'],
    'the first list stops detail work at its configured cap');
  assert.strictEqual(detailCalls.filter((id) => id === 'LIST-1').length, 1,
    'a native value is served from this adapter memory on the next list');
  assert.strictEqual(detailCalls.filter((id) => id === 'LIST-2').length, 1,
    'a successful native absence is cached for its short metadata TTL');
  assert.strictEqual(detailCalls.filter((id) => id === 'LIST-3').length, 2,
    'a wrong-load response retries on the next enriched list');
  assert.strictEqual(detailCalls.filter((id) => id === 'LIST-4').length, 1,
    'the next list spends its remaining cap slot on the previously excluded row');
  assert.strictEqual(first.find((load) => load.id === 'LIST-1').dimensions, NATIVE_DIMENSIONS,
    'a positive detail value maps on the cold list');
  assert.strictEqual(second.find((load) => load.id === 'LIST-1').dimensions, NATIVE_DIMENSIONS,
    'the same positive value maps from cache');
  assert.strictEqual(first.find((load) => load.id === 'LIST-2').dimensions, null,
    'a native N/A value is omitted without aborting the list');
  assert.strictEqual(first.find((load) => load.id === 'LIST-3').dimensions, null,
    'a wrong-load detail response is omitted without aborting the list');
  assert.strictEqual(second.find((load) => load.id === 'LIST-3').dimensions, NATIVE_DIMENSIONS,
    'a wrong-load response is not cached and the matching next response is retried');
  assert.strictEqual(first.find((load) => load.id === 'LIST-4').dimensions, null,
    'a cap-excluded load has no inferred size');
  assert.strictEqual(rttAfterFirst - rttBefore, 1,
    'detail lookups do not enter the adapter RTT history used by bid timing');

  // The configured TTL is a freshness bound, not a forever-cache: refresh after it elapses.
  let staleCalls = 0;
  const staleAdapter = new RealSuperProcureAdapter({
    token: 'test-token', sizeDetailTtlMs: 1,
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      if (init.method === 'POST' && parsed.pathname.endsWith('/sp/loads/v4')) {
        return response(200, { data: { loadDetails: [rawLoad('STALE-1', { branchDimensions: 1 })] } });
      }
      staleCalls += 1;
      return response(200, nativeDetail('STALE-1', staleCalls === 1 ? NATIVE_DIMENSIONS : '8 x 4 x 8 ft'));
    },
  });
  staleAdapter.account = readyAccount();
  await staleAdapter.listAuctions({ enrichDimensions: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const refreshed = await staleAdapter.listAuctions({ enrichDimensions: true });
  assert.strictEqual(staleCalls, 2, 'a stale cached value refreshes on the next enriched list');
  assert.strictEqual(refreshed[0].dimensions, '8 x 4 x 8 ft', 'the refresh replaces the old native scalar');

  // A near-close load stays on the existing listing path; size enrichment cannot consume its runway.
  let urgentDetailCalls = 0;
  const urgentAdapter = new RealSuperProcureAdapter({
    token: 'test-token',
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      if (init.method === 'POST' && parsed.pathname.endsWith('/sp/loads/v4')) {
        return response(200, { data: { loadDetails: [rawLoad('URGENT-1', {
          branchDimensions: 1, biddingCloseTime: new Date(Date.now() + 59_000).toISOString(),
        })] } });
      }
      urgentDetailCalls += 1;
      throw new Error('near-close size lookup must not run');
    },
  });
  urgentAdapter.account = readyAccount();
  const urgent = await urgentAdapter.listAuctions({ enrichDimensions: true });
  assert.strictEqual(urgentDetailCalls, 0, 'a load closing within 60 seconds skips size enrichment');
  assert.strictEqual(urgent[0].dimensions, null, 'the urgent row remains usable with no guessed size');
}

(async () => {
  try {
    await should_display_only_native_carrier_drawer_dimensions_when_pricing_a_superprocure_load();
    console.log('1/1 checks passed');
  } catch (error) {
    console.error('FAIL: 0/1 checks - SuperProcure native drawer dimensions did not reach the desk correctly');
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
})();
