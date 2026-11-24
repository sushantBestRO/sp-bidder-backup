'use strict';
/**
 * PIN CODES ON THE LANE LINE (Director ask, 2026-07-27: "the pin code appears when you click
 * the link but it should also appear in the message if possible").
 *
 * The minimal WhatsApp ask names the lane as CITIES only ("Vejalpur -> CBD BELAPUR"), and an
 * Indian city name is not unique - the desk was opening the /price link just to find out which
 * Vejalpur it was pricing. The pin is the disambiguator and it is already on the load snapshot.
 *
 * THIS FILE ORIGINALLY SHIPPED ITS OWN address-only reader (pincodeOf) here, while the /price
 * page had note recovery (src/pricing/lanePins.js, landed as #130 after #125). On the real load
 * 23674031 that meant the page rendered "Kanpur 209304" and the ask rendered "Kanpur" - two
 * surfaces stating different pins for the same load - and part D of this file's own "agreement"
 * check passed anyway, because it only ever exercised the clean SIKA fixture, where address-only
 * parsing and note-recovery happen to land on the same answer. That is agreement BY
 * CONSTRUCTION, not proof the two surfaces actually agree.
 *
 * pincodeOf is gone. laneEnds now reads laneDisplay.laneEndPins, which wraps pricing/lanePins.js -
 * THE single reader, also used by server.js's renderLoadCard - so there is exactly one definition
 * of the rule in the repo. Reader-level edge cases (GST numbers, 10-digit mobiles, the note-halves
 * split, the 7-digit refusal) are already covered in scripts/test-pin-from-notes.js; this file
 * covers the WhatsApp-specific surface: laneEnds's composition/degrade ladder, the rendered ask,
 * and - the part that actually matters - the ask and the /price page fetched over REAL HTTP,
 * checked against EXPLICIT expected pins, on both a clean fixture and the load-23674031 shape (a
 * 7-digit point pin, a note that recovers only one end, and a drop with no pin anywhere).
 *
 * The lane ends themselves are no longer one arrow-joined string: each has its own labelled line
 * in the ask (see scripts/test-ask-lane-segregation.js for why), and the city is written through
 * src/web/laneDisplay.js, so a SuperProcure end the branch typed in caps reads "Cbd Belapur" here
 * exactly as it already did on the /price page. The pin is untouched by that and is what this
 * file is about.
 *
 * What this pins:
 *   A. laneEnds    - `{from, to}` as "<city> <pin>", first-pickup / last-drop, degrading one end
 *                    at a time, including a shape that needs the note fallback.
 *   B. the ask     - the rendered price_needed message carries each pin on its own labelled line,
 *                    on both the clean fixture and the load-23674031 shape.
 *   C. agreement   - the /price page's lane-header pin sub-labels and the ask's lane lines,
 *                    fetched over real HTTP, are checked against explicit expected values (not
 *                    against each other) on the clean case AND on the load-23674031 shape.
 *
 *   node scripts/test-lane-pincodes.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-pins-'));

const http = require('http');
const assert = require('assert');
const { laneEnds, renderMessage } = require('../src/notify/waTemplates');
const { app, requests } = require('../src/web/server');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// The shape parsePoints (realAdapter.js) composes: party first, then place, then the pin.
const pt = (kind, address) => ({ kind, address });

// The real 2026-07-27 SIKA load from the Director's message, in snapshot form - both ends carry
// a clean six-digit pin in their own address, no note needed.
const SIKA = {
  id: '23534893',
  lane: { origin: 'Vejalpur', destination: 'CBD BELAPUR' },
  points: [
    pt('pickup', 'SIKA INDIA PVT LTD, Vejalpur, Gujarat 389340, IN'),
    pt('drop', 'CBD BELAPUR, Navi Mumbai, Maharashtra 400614, IN'),
  ],
  equipment: 'AP: Truck flat 9 ton-Open Body', units: 1, weight: 9, weightUnit: 'MT',
  companyName: 'SIKA India', branchName: 'Vejalpur - Toll (IN04)',
  closesAt: Date.now() + 30 * 60_000, status: 'live',
};

// Load 23674031 (Kanpur -> Gorakhpur, Havells) - the real case #114's own reader got wrong.
// The pickup's pin arrives as SEVEN digits (2209304), which pinIn correctly refuses rather than
// trims; the note spells the real origin pin (209304) but never mentions a destination pin at
// all, so the drop must stay bare. Fixture matches scripts/test-pin-from-notes.js's
// REAL_POINTS/REAL_NOTES exactly, so both files are asserting about the same real load.
const KANPUR = {
  id: '23674031',
  lane: { origin: 'KANPUR', destination: 'GORAKHPUR' },
  points: [
    pt('pickup', 'Havells India Ltd., Kanpur, Uttar Pradesh, India, 2209304'),
    pt('drop', 'Gorakhpur, Uttar Pradesh, India'),
  ],
  notes: 'Origin Address - 770, JUGRAJPUR ROAD, SACHENDI, NATIONAL HIGHWAY -2, KANPUR - 209304,'
    + 'KANPUR + Destination Address- 127-2/348,CHATUR BHUJ NIWAS,NEAR MANAS TALKIESALI NAGAR NORTH',
  equipment: '19 FT 7 MT', units: 1, weight: 7, weightUnit: 'MT',
  companyName: 'Havells India Ltd.', branchName: 'Kanpur',
  closesAt: Date.now() + 30 * 60_000, status: 'live',
};

(async () => {
  // ---- A. laneEnds: composition + one-end-at-a-time degrade, including the note fallback ----
  {
    assert.deepStrictEqual(laneEnds(SIKA, 'sp'), { from: 'Vejalpur 389340', to: 'Cbd Belapur 400614' }, 'both ends carry their own address pin');
    // Multi-drop: the lane header annotates the ALREADY-collapsed city pair, so the LAST drop's
    // pin is the one shown - the full route stays on the /price page, not in the message.
    const multiDrop = { ...SIKA, points: [SIKA.points[0], pt('drop', 'Bhiwandi, Maharashtra 421302, IN'), pt('drop', 'CBD BELAPUR, Navi Mumbai, Maharashtra 400614, IN')] };
    assert.strictEqual(laneEnds(multiDrop, 'sp').to, 'Cbd Belapur 400614', 'multi-drop: the LAST drop pins the destination end');
    // Degrade one end at a time - never a dangling separator, never a "?" where a city exists.
    const noDropPin = { ...SIKA, points: [SIKA.points[0], pt('drop', 'CBD BELAPUR, Navi Mumbai')] };
    assert.deepStrictEqual(laneEnds(noDropPin, 'sp'), { from: 'Vejalpur 389340', to: 'Cbd Belapur' }, 'a pin-less drop leaves that end a bare city');
    const noPickupPoint = { ...SIKA, points: [SIKA.points[1]] };
    assert.deepStrictEqual(laneEnds(noPickupPoint, 'sp'), { from: 'Vejalpur', to: 'Cbd Belapur 400614' }, 'a missing pickup point leaves that end a bare city');
    // A sim/mock load (no points at all) still renders the bare cities.
    assert.deepStrictEqual(laneEnds({ lane: { origin: 'Pune', destination: 'Indore' } }, 'sp'), { from: 'Pune', to: 'Indore' }, 'a point-less load reads exactly as it did before pins existed');
    assert.strictEqual(laneEnds({ lane: { origin: 'Pune', destination: '' } }, 'sp').to, '?', 'a half-known lane keeps the existing "?" placeholder');
    assert.deepStrictEqual(laneEnds({}, 'sp'), { from: '', to: '' }, 'no lane at all -> both ends "" (the template applies its own "-" fallback)');
    assert.deepStrictEqual(laneEnds(null, 'sp'), { from: '', to: '' }, 'no load -> both ends "" (never a throw)');
    // THE CASE: a 7-digit point pin is refused, the note recovers the origin, and the destination
    // - which carries no pin anywhere, address or note - stays a bare city. #114's own
    // pincodeOf(address)-only reader could not do this: it rendered "KANPUR -> GORAKHPUR" (both
    // ends blank of a pin) for this exact load, while the /price page already showed 209304.
    assert.deepStrictEqual(laneEnds(KANPUR, 'sp'), { from: 'Kanpur 209304', to: 'Gorakhpur' }, 'load 23674031 shape: the note recovers the origin pin past the 7-digit refusal; the drop has none anywhere and stays bare');
    ok('laneEnds: pins both ends from first-pickup/last-drop, degrades one end at a time, recovers via the note, "" with no lane');
  }

  // ---- B. the rendered ask ----
  {
    const ask = (load, extra) => {
      const e = laneEnds(load, 'sp');
      return renderMessage('price_needed', { laneFrom: e.from, laneTo: e.to, ...extra });
    };
    const m = ask(SIKA, {
      shipperName: 'SIKA India', branch: 'Vejalpur - Toll (IN04)', name: '23534893', loadCode: 'IN041',
      cargo: '1 x AP: Truck flat 9 ton-Open Body . 9 MT',
      closesText: '27-07-2026 03:30 PM (enter cost by 03:28 PM)', link: 'http://x/price/1',
    });
    assert.ok(/📍 \*From\* - Vejalpur 389340\n🎯 \*To\* - Cbd Belapur 400614/.test(m), 'the ask names each pin on its own labelled line');
    assert.ok(!/SIKA INDIA PVT LTD/.test(m) && !/Gujarat/.test(m), 'the ask still carries only the SHORT lane - the full addresses stay on the /price page');
    assert.strictEqual(m.split('\n').filter(Boolean).length, 7, 'the ask is seven lines - segregating From/To adds exactly one, and the pins still ride the ends they belong to');

    const kanpurMsg = ask(KANPUR, {
      shipperName: 'Havells India Ltd.', branch: 'Kanpur', name: '23674031', loadCode: '',
      cargo: '1 x 19 FT 7 MT . 7 MT',
      closesText: '01-08-2026 03:30 PM (enter cost by 03:28 PM)', link: 'http://x/price/2',
    });
    assert.ok(/📍 \*From\* - Kanpur 209304\n🎯 \*To\* - Gorakhpur/.test(kanpurMsg), 'load 23674031: the ask carries the note-recovered origin pin and a bare destination');
    ok('price_needed: each lane end is its own "<label> - <city> <pin>" line, full addresses still page-only, note-recovered pins included');
  }

  // ---- C. the message and the /price page agree, checked against explicit expected values ----
  {
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (p) => new Promise((resolve, reject) => {
      const u = new URL(base + p);
      const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET' },
        (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => resolve({ status: res.statusCode, text: buf })); });
      r.on('error', reject);
      r.end();
    });
    const pagePins = (html) => (String(html).match(/<div class="spin">(\d{6})<\/div>/g) || []).map((s) => s.match(/\d{6}/)[0]);

    // Clean case: both ends carry an address pin. This alone is what the original test checked,
    // and it is NOT enough - it cannot distinguish a shared reader from two readers that merely
    // happen to agree on easy inputs.
    const created = await requests.createForLoad(SIKA);
    const page = await get(`/price/${created.id}`);
    assert.strictEqual(page.status, 200, 'the capture page renders');
    assert.deepStrictEqual(pagePins(page.text), ['389340', '400614'], 'the page shows both pins as lane sub-labels');
    assert.deepStrictEqual(laneEnds(created.load, 'sp'), { from: 'Vejalpur 389340', to: 'Cbd Belapur 400614' }, 'the ask names the exact same two pins the page shows');

    // Load 23674031 shape: one end needs the note, the other has no pin anywhere. This is the
    // case the original "agree, by construction" test never exercised - the clean SIKA fixture
    // could not have caught the real bug, because pincodeOf(address) and lanePins(load) happen
    // to agree when every pin is a clean six digits in the address. They do NOT agree here,
    // which is exactly why this shape is the one that has to be asserted against explicit values.
    const createdKanpur = await requests.createForLoad(KANPUR);
    const kanpurPage = await get(`/price/${createdKanpur.id}`);
    assert.strictEqual(kanpurPage.status, 200, 'the capture page renders for the 23674031 shape');
    assert.deepStrictEqual(pagePins(kanpurPage.text), ['209304'], 'the page shows ONLY the note-recovered origin pin - the drop has none anywhere');
    assert.deepStrictEqual(laneEnds(createdKanpur.load, 'sp'), { from: 'Kanpur 209304', to: 'Gorakhpur' }, 'the ask names the SAME single pin the page shows, and invents no destination pin');

    server.close();
    ok('/price page + WhatsApp ask read the SAME pins off the same load on both a clean fixture and the load-23674031 shape - genuine agreement, not agreement by construction');
  }

  console.log(`\n${pass}/3 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
