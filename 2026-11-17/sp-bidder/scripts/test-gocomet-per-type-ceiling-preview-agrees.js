'use strict';
/**
 * The price the page promises and the price the adapter will send must agree on a per-truck-type
 * load that carries a shipper ceiling.
 *
 * planPreview (what the /price page and its confirmation read) caps the ladder against the ceiling
 * in BLENDED space. The GoComet write loop asserts the ceiling on each truck type's own LINE, which
 * scales away from the blended rung. A load whose blended ladder fits the ceiling but whose dearer
 * type's line does not is therefore confirmed as biddable and then refused at every rung: it never
 * bids, and the desk was told it would.
 *
 * Neutral on the repair: the check passes if the preview declares the load unbiddable, or if every
 * rung it presents clears the adapter's belts.
 *
 *   node scripts/test-gocomet-per-type-ceiling-preview-agrees.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');

let pass = 0;
const EXPECTED = 2;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-pertype-preview-'));
const cleanup = () => { try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch (_) {} };

function previewEngine() {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'soft' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: false }),
  };
  return new BidEngine(adapter, new DurableScheduler(path.join(TMPDIR, `intent-${pass}.json`)), { config: {} });
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const validToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' })}.sig`;
const line = (units) => ({
  units, price: 1, unit_name: 'TRUCK', currency: 'INR', taxable: '1', tax_id: '0',
  include_in_rank: true, is_custom_field: false, split_charge: false,
});
const quote = () => ({
  id: 'QC',
  charges_list: { '11_freight_charges': { display_name: 'Freight Charges',
    freight_charges_custom_charge_40ft: line(1), freight_charges_custom_charge_20ftodc: line(9) } },
  total_charges: { total: { units: 10, quote_units: 1, unit_name: 'TRUCK', total: 0, currency: 'INR' } },
});
const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

async function adapter() {
  const a = new GoCometAdapter({
    token: validToken(), bidEnabled: true, sleep: async () => {},
    fetchImpl: async (url, init) => {
      if (init.method === 'GET' && String(url).includes('/quotes')) return resp(200, [quote()]);
      if (init.method === 'PUT' && String(url).includes('/submit')) return resp(200, { data: { quote_rank: 2, can_submit_quote: true } });
      return resp(404, { error: 'no_route' });
    },
  });
  await a.login();
  return a;
}

// 40 ft x1 at 100,000 plus 20 ft ODC x9 at 10,000: blended base 19,000.
const spec = { cost: 19000, types: [
  { label: '40 ft', match: '40ft', count: 1, cost: 100000 },
  { label: '20 ft ODC', match: '20ftodc', count: 9, cost: 10000 },
] };
const band = { cost: 19000, marginsPct: [20, 15, 10], minMarginPct: 10 };

async function refusedRungs(ceilingPrice) {
  const rules = { ceilingPrice, costByType: spec };
  const preview = previewEngine().planPreview({ id: 'PT1', rules, companyName: 'Fixture Co' }, band);
  const refused = [];
  if (!preview.willNotBid) {
    const a = await adapter();
    for (const rung of preview.ladder) {
      try { await a.placeBid('PT1', rung, Object.assign({}, rules, { floor: preview.floor })); }
      catch (e) { refused.push(`${rung} (${e.code})`); }
    }
  }
  return { preview, refused };
}

(async () => {
  {
    const { preview, refused } = await refusedRungs(200000);
    assert.ok(!preview.willNotBid && preview.ladder.length > 0, 'CONTROL: a generous ceiling leaves a biddable ladder');
    assert.deepStrictEqual(refused, [], `CONTROL: every rung under a generous ceiling is sendable (refused: ${refused.join(', ')})`);
    ok('CONTROL: under a generous ceiling every rung the preview shows is sendable');
  }
  {
    const { preview, refused } = await refusedRungs(25000);
    assert.deepStrictEqual(refused, [],
      `MECHANISM: the preview presents ${JSON.stringify(preview.ladder)} as biddable but the adapter refuses ${refused.length} of them: ${refused.join(', ')}`);
    ok('the preview either declares the load unbiddable or shows only rungs the adapter will send');
  }
  cleanup();
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass}`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => { cleanup(); console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
