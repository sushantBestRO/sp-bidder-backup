'use strict';
/**
 * BC-36: GoComet's extra pickup/drop points, mapped onto the load as city/pincode pairs.
 *
 * Structured, not just free text (2026-09-25 read-only capture of a real two-point Waaree
 * enquiry): `GET /enquiries/{key}` carries `other_origins` / `other_origin_zip_codes` /
 * `other_destinations` / `other_destination_zip_codes`, plain string arrays, `[]` on a
 * single-point load. Reduced to `{city, pincode}` at the parse boundary via the same
 * pincode-anchored parser the primary lane uses (gocometLane.parseGoCometPlace) - never the raw
 * street address, which is the "obviously fake" data below stands in for.
 *
 * Owner default OD-2: `quote_approved_by` (a third party's name, phone, email and a password
 * digest, on the same enquiry endpoint) must never survive the parse boundary, same as
 * `created_by` - checked here the same way test-gocomet-adapter.js checks `created_by`.
 *
 * Offline unit tests, fully mocked HTTP transport - the house pattern (see test-gocomet-adapter.js).
 * All addresses, pincodes and the fake "person" below are made up for this test.
 *
 *   node scripts/test-gocomet-two-point-mapping.js
 */
const assert = require('assert');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const validToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' })}.sig`;
function resp(status, body) {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}
function makeFetch(handler) {
  const fetchImpl = async (url, init) => handler(url, init) || resp(404, { error: 'no_route' });
  return fetchImpl;
}
const noSleep = async () => {};
const fixedNow = (t) => () => t;

const FAKE_APPROVER = {
  name: 'Fake Approver', email: 'fake.approver@example.test', phone: '9000000001',
  employee_id: 'FAKE-1', password_digest: 'deadbeef00112233445566778899aabbccddeeff',
};

(async () => {
  const base = Date.now();
  const goodTs = new Date(base + 3600_000).toISOString();
  const listBody = { data: { total_page: 1, enquiries: [
    { key: 'K1', origin: 'A', destination: 'B', bidding_closed: false, bid_close_timestamp: goodTs },
  ] } };

  // ---- single-point load: other_* arrive as [] -> the mapped load carries NEITHER key ---------
  {
    const fetchImpl = makeFetch((url) => {
      if (url.includes('/enquiries/spot')) return resp(200, listBody);
      if (/\/enquiries\/K1$/.test(url)) {
        return resp(200, { data: {
          cargo_quantity: 1, cargo_unit: 'TRUCK', slab_rate: 100,
          other_origins: [], other_origin_zip_codes: [],
          other_destinations: [], other_destination_zip_codes: [],
          quote_approved_by: FAKE_APPROVER,
        } });
      }
      return resp(404, {});
    });
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, now: fixedNow(base) });
    const list = await a.listAuctions();
    ok(!('otherOrigins' in list[0]), 'single-point load: no otherOrigins key at all (never an empty array)');
    ok(!('otherDestinations' in list[0]), 'single-point load: no otherDestinations key at all');
  }

  // ---- two-point load: one structured extra destination -> {city, pincode} ---------------------
  {
    const fetchImpl = makeFetch((url) => {
      if (url.includes('/enquiries/spot')) return resp(200, listBody);
      if (/\/enquiries\/K1$/.test(url)) {
        return resp(200, { data: {
          cargo_quantity: 1, cargo_unit: 'TRUCK', slab_rate: 100,
          other_origins: [], other_origin_zip_codes: [],
          other_destinations: ['Fake Extra Stop Road, Near Fake Landmark, Faketown-333333, Test State'],
          other_destination_zip_codes: ['333333'],
          quote_approved_by: FAKE_APPROVER,
        } });
      }
      return resp(404, {});
    });
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, now: fixedNow(base) });
    const list = await a.listAuctions();
    ok(Array.isArray(list[0].otherDestinations) && list[0].otherDestinations.length === 1,
      `one extra destination maps to one stop (got ${JSON.stringify(list[0].otherDestinations)})`);
    ok(list[0].otherDestinations[0].city === 'Faketown', `city parsed as Faketown (got ${list[0].otherDestinations[0].city})`);
    ok(list[0].otherDestinations[0].pincode === '333333', `pincode carried through (got ${list[0].otherDestinations[0].pincode})`);
    // the leak this whole feature must never reopen
    const serialized = JSON.stringify(a._detailCache.get('K1'));
    ok(!/password_digest|Fake Approver|fake\.approver/.test(serialized), 'quote_approved_by never enters the cache');
    // never a raw street address either
    ok(!/Near Fake Landmark/.test(JSON.stringify(list[0].otherDestinations)), 'the mapped stop carries no street text, only city/pincode');
  }

  // ---- two extra stops (one origin, one destination) -> both mapped, independently -------------
  {
    const fetchImpl = makeFetch((url) => {
      if (url.includes('/enquiries/spot')) return resp(200, listBody);
      if (/\/enquiries\/K1$/.test(url)) {
        return resp(200, { data: {
          cargo_quantity: 1, cargo_unit: 'TRUCK', slab_rate: 100,
          other_origins: ['Fake Pickup Two Road, Sampleville-444444, Test State'],
          other_origin_zip_codes: ['444444'],
          other_destinations: ['Fake Drop Two Road, Otherplace-555555, Test State'],
          other_destination_zip_codes: ['555555'],
        } });
      }
      return resp(404, {});
    });
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, now: fixedNow(base) });
    const list = await a.listAuctions();
    ok(list[0].otherOrigins && list[0].otherOrigins[0].city === 'Sampleville', `extra origin city (got ${JSON.stringify(list[0].otherOrigins)})`);
    ok(list[0].otherDestinations && list[0].otherDestinations[0].city === 'Otherplace', `extra destination city (got ${JSON.stringify(list[0].otherDestinations)})`);
  }

  // ---- an extra stop that parses to neither a city nor a pincode is DROPPED, not passed through
  {
    const fetchImpl = makeFetch((url) => {
      if (url.includes('/enquiries/spot')) return resp(200, listBody);
      if (/\/enquiries\/K1$/.test(url)) {
        return resp(200, { data: {
          cargo_quantity: 1, cargo_unit: 'TRUCK', slab_rate: 100,
          other_destinations: ['###!!!$$$'], other_destination_zip_codes: [''],
        } });
      }
      return resp(404, {});
    });
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, now: fixedNow(base) });
    const list = await a.listAuctions();
    ok(!('otherDestinations' in list[0]), 'an unparseable stop is dropped, never forwarded as a raw string');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
