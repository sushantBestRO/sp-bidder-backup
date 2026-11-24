'use strict';
/**
 * The lane block on /price cannot grow to fill the card, and cannot lose the address while doing it.
 *
 * The defect this pins: GoComet puts a full postal address in the lane field and publishes no
 * points array at all, so the lane header was the only place that address ever appeared - rendered
 * at 17px/700 it ran to eleven bold lines and pushed the cost input off a phone screen. #186 parses
 * a city out of it, which fixes the 84 of 88 live addresses that parse; the four that do not still
 * rendered the raw blob, and every price request captured before #186 carries no laneParsed at all
 * and renders it forever.
 *
 * So the header is CLAMPED, and the clamp is only safe because the untruncated address is rendered
 * below it. THOSE TWO ARE ONE DECISION and this file exists to stop them being separated: a change
 * that keeps the clamp and drops the address fallback truncates the address with no full copy
 * anywhere, which is worse than the layout bug it replaced. An earlier cut of this fix had exactly
 * that hole - it suppressed the fallback when the header already showed the same string, which is
 * precisely the unparseable case whose header the clamp truncates.
 *
 * Addresses are real strings read off the production box, not tidied inventions - the whole failure
 * mode is real data being uglier than test data.
 *
 * Parses the SHIPPED bytes over real HTTP, same reasoning as test-price-page-platform.js: the
 * markup is assembled inside template literals and a source read cannot catch a rendering mistake.
 *
 *   node scripts/test-price-page-lane-block.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-price-lane-'));

const http = require('http');
const { app, requests } = require('../src/web/server');
const { parseGoCometLane } = require('../src/platform/gocometLane');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET' },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => resolve({ status: res.statusCode, text: buf })); });
    r.on('error', reject);
    r.end();
  });
}

// Verbatim off the live box (read-only GET /api/price-requests, 2026-08-12).
const DEGAM = 'Survey No. 1934, NH-48, Near Darshan Hotel, Village # Degam, Taluka # Chikhli, Degam-396530, Gujarat';
const PATAN = 'SOLARCRAFT POWER INDIA 5 - Survey No 397/p1/p3,398/p3, Khata 590    Sarswati,Delvada,  Patan, - 384285';
// Neither of these carries a pincode, so the parser correctly declines both and the header IS the
// raw address. This is the pair that defeats #186.
const KUTCH = 'Sanagam Solar one PVT LTD - Samakhayli kutch';
const NANDED = 'M/S Rudransh Electrical Gut No 13 Plot No 22, Ram Nagar Kautha Nanded Waghala (M Corp), Navin Bridge, Nanded, Santoshi Mata MOB:8866950131 Near Ram Mandir';

function gcLoad(id, origin, destination, { withParsed = true } = {}) {
  const L = {
    id, lane: { origin, destination }, equipment: 'FTL', units: 1,
    companyName: 'Waaree Energies Ltd.', cargoLines: 1,
    closesAt: Date.now() + 30 * 60_000, startsAt: Date.now() - 60_000,
    status: 'live', softClose: true, closeModelKnown: true,
  };
  if (withParsed) {
    L.laneParsed = parseGoCometLane({ origin, destination, origin_zip_code: null, destination_zip_code: null });
  }
  return L;
}

// SuperProcure's own shape: a short city lane plus a real points array.
function spLoad(id) {
  return {
    id, lane: { origin: 'Bhiwandi', destination: 'Nagpur' }, equipment: '32ft SXL', units: 1,
    weight: 21, weightUnit: 'MT', productName: 'Steel coils', distanceKm: 705,
    companyName: 'Havells India', closesAt: Date.now() + 30 * 60_000, startsAt: Date.now() - 60_000,
    status: 'live', softClose: false, closeModelKnown: true,
    points: [
      { kind: 'pickup', address: 'Plot 14, MIDC Bhiwandi, Thane 421302' },
      { kind: 'drop', address: 'Warehouse 7, MIHAN SEZ, Nagpur 441108' },
    ],
  };
}

// The address rows, as one blob - the assertions below ask what is present, never in what order.
const addrBlock = (html) => {
  const m = /<div class="saddrs">([\s\S]*?)<\/div>\s*<div class="lmeta">/.exec(html);
  return m ? m[1] : '';
};
const laneHeader = (html) => {
  const m = /<div class="slane">([\s\S]*?)<\/div>\s*<div class="sgrid">/.exec(html);
  return m ? m[1] : '';
};

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = async (load) => (await get(`${base}/price/${(await requests.createForLoad(load)).id}`)).text;

  // --- the clamp itself, once, from the served stylesheet ---
  {
    const html = await page(gcLoad('LB-CSS', DEGAM, PATAN));
    ok(/\.lc-spec \.scity\{[^}]*line-clamp:2/.test(html),
      'the lane header is capped at two lines, so no address can dominate the card');
    ok(!/\.lc-spec \.scity\{[^}]*font-size:17px/.test(html),
      'and it is no longer sized as the page headline');
  }

  // --- A. an address the parser reads: header shortens, full string survives below ---
  {
    const html = await page(gcLoad('LB-1', DEGAM, PATAN));
    const head = laneHeader(html);
    // The state left this header deliberately (the pincode already renders under the city, so
    // "City, State" made the header two facts wide where SuperProcure's is one). The assertion
    // this file exists to make is unchanged and is now stated directly rather than through a
    // particular label string: a city heads the card and the postal blob does not.
    ok(head.includes('Degam') && head.includes('Patan') && !head.includes('Survey No.'),
      'a parsed GoComet lane heads the card with cities, not the postal blob');
    ok(!head.includes('Gujarat'),
      'and with the city only - the state is carried by the full address row, not the header');
    ok(!head.includes('Near Darshan Hotel') && !head.includes('SOLARCRAFT'),
      'and the header carries none of the address the city replaced');
    const addrs = addrBlock(html);
    ok(addrs.includes('Near Darshan Hotel') && addrs.includes('Degam-396530'),
      'the whole pickup address is still on the page, in the address rows');
    ok(addrs.includes('SOLARCRAFT POWER INDIA 5') && addrs.includes('384285'),
      'and so is the whole drop address - shortening the header must never drop the string');
    ok(/<span class="sk">Pickup<\/span>/.test(addrs) && /<span class="sk">Drop<\/span>/.test(addrs),
      'they are labelled Pickup and Drop, the same rows a points-carrying load fills');
  }

  // --- B. THE HOLE THIS FILE EXISTS FOR: an address the parser declines ---
  {
    const html = await page(gcLoad('LB-2', KUTCH, NANDED));
    const head = laneHeader(html);
    ok(head.includes('Sanagam Solar one PVT LTD') && head.includes('M/S Rudransh Electrical'),
      'an unparseable address still heads the card - the raw string is the honest fallback');
    const addrs = addrBlock(html);
    ok(addrs.includes('Near Ram Mandir'),
      'and its FULL text renders below, even though the header shows the same string - the clamp '
      + 'truncates this header, so suppressing the duplicate would hide the end of the address');
    ok(addrs.includes('Samakhayli kutch'), 'both ends get the treatment, not just the long one');
  }

  // --- C. a request captured before laneParsed existed (every row in the store today) ---
  {
    const html = await page(gcLoad('LB-3', DEGAM, PATAN, { withParsed: false }));
    ok(laneHeader(html).includes('Survey No. 1934'),
      'with no laneParsed the header falls back to the raw lane exactly as it always did');
    ok(addrBlock(html).includes('Degam-396530, Gujarat'),
      'and the clamped-away remainder is recoverable from the address rows');
  }

  // --- D. SuperProcure is untouched: it carries points, so nothing is synthesised ---
  {
    const html = await page(spLoad('LB-4'));
    const head = laneHeader(html);
    ok(head.includes('Bhiwandi') && head.includes('Nagpur'), 'an SP lane still heads the card with its cities');
    const addrs = addrBlock(html);
    ok(addrs.includes('Plot 14, MIDC Bhiwandi') && addrs.includes('MIHAN SEZ'),
      'and its address rows are the portal\'s own points, unchanged');
    ok((addrs.match(/<span class="sk">/g) || []).length === 2,
      'exactly two rows - a points-carrying load never also gets the lane-string fallback');
  }

  server.close();

  // COMPLETION SENTINEL. run-tests.js grades a file by EXIT STATUS only, so a file that returns
  // early - an unref'd timer, an early return, a swallowed rejection - exits 0 having asserted
  // nothing and is scored a pass. Pinning the count makes a vacuous green impossible.
  const EXPECTED_CHECKS = 16;
  const ran = pass + fail;
  if (ran !== EXPECTED_CHECKS) {
    console.error(`  FAIL - completion sentinel: ran ${ran} checks, expected ${EXPECTED_CHECKS} (a check was skipped or added without updating EXPECTED_CHECKS)`);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  console.log(`\n${pass} passed, ${fail} failed (${ran}/${EXPECTED_CHECKS} checks reached the sentinel)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
