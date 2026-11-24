'use strict';
/**
 * Pin-code recovery on the /price load card, including the live case that made it necessary.
 *
 * THE CASE. Load 23674031 (Kanpur -> Gorakhpur, Havells) rendered with NO pin at either end.
 * Both ends were legitimately empty as far as the old reader was concerned:
 *
 *   pickup address : "Havells India Ltd., Kanpur, Uttar Pradesh, India, 2209304"
 *   drop address   : "Gorakhpur, Uttar Pradesh, India"
 *   notes          : "Origin Address - 770, JUGRAJPUR ROAD, SACHENDI, NATIONAL HIGHWAY -2,
 *                     KANPUR - 209304,KANPUR + Destination Address- 127-2/348,CHATUR BHUJ
 *                     NIWAS,NEAR MANAS TALKIESALI NAGAR NORTH"
 *
 * The pickup's pin came through SuperProcure as SEVEN digits. `\b\d{6}\b` refuses that, which is
 * the correct call - 2209304 is either 220930 or 209304 and nothing in the point payload says
 * which. The note settles it: the origin pin is 209304. The destination has no pin anywhere, in
 * the address or the note, so it must stay absent.
 *
 * WHAT THIS PINS
 *   1. the real load recovers 209304 for origin and NOTHING for destination
 *   2. an address pin still wins over the note (the note is a fallback, never an override)
 *   3. a note with no "Destination Address" marker attributes NOTHING - the origin's pin must
 *      never leak onto the drop, which is the whole risk of reading one string for both ends
 *   4. the 7-digit value is never trimmed into a 6-digit guess, in either direction
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-pin-notes-'));
process.env.SP_NOTIFY_MODE = 'dashboard';
delete process.env.PLATFORM;
delete process.env.SP_ADMIN_PASS_HASH;

const http = require('http');
const { app, requests } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`); } else { fail++; console.error('  FAIL -', m); } };

function get(base, p) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

// The pin renders in the lane header as <div class="spin">NNNNNN</div>, origin first then
// destination. An absent pin produces no div at all, so the list itself carries the meaning.
const pinsOf = (html) => (String(html).match(/<div class="spin">(\d+)<\/div>/g) || [])
  .map((s) => s.replace(/\D/g, ''));

const REAL_POINTS = [
  { kind: 'pickup', address: 'Havells India Ltd., Kanpur, Uttar Pradesh, India, 2209304' },
  { kind: 'drop', address: 'Gorakhpur, Uttar Pradesh, India' },
];
const REAL_NOTES = 'Origin Address - 770, JUGRAJPUR ROAD, SACHENDI, NATIONAL HIGHWAY -2, '
  + 'KANPUR - 209304,KANPUR + Destination Address- 127-2/348,CHATUR BHUJ NIWAS,NEAR MANAS '
  + 'TALKIESALI NAGAR NORTH';

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const now = Date.now();
  let seq = 0;
  const pins = async (points, notes) => {
    const r = await requests.createForLoad({
      id: `PIN-${++seq}`,
      lane: { origin: 'KANPUR', destination: 'GORAKHPUR' },
      equipment: '19 FT 7 MT', units: 1, companyName: 'Havells India Ltd.',
      closesAt: now + 10 * 60_000, startsAt: now - 60_000, status: 'live',
      quoteType: 'FTL', points, notes,
    });
    const res = await get(base, `/price/${r.id}`);
    return { pins: pinsOf(res.body), body: res.body };
  };

  // ---- 1. the real load ----
  {
    const { pins: p } = await pins(REAL_POINTS, REAL_NOTES);
    ok(JSON.stringify(p) === JSON.stringify(['209304']),
      `load 23674031: origin pin 209304 recovered from the note, destination absent (got ${JSON.stringify(p)})`);
  }

  // ---- 4. the 7-digit value is never trimmed into a guess ----
  {
    const { pins: p, body } = await pins(REAL_POINTS, '');   // no note -> nothing to fall back to
    ok(JSON.stringify(p) === JSON.stringify([]),
      `a 7-digit point pin yields NO pin rather than a trimmed guess (got ${JSON.stringify(p)})`);
    ok(!/<div class="spin">220930<\/div>/.test(body) && !/<div class="spin">209304<\/div>/.test(body),
      'neither 220930 nor 209304 is invented from 2209304 when no note confirms it');
  }

  // ---- 2. an address pin wins over the note ----
  {
    const { pins: p } = await pins([
      { kind: 'pickup', address: 'Somewhere, Kanpur, 208001' },
      { kind: 'drop', address: 'Gorakhpur, 273001' },
    ], REAL_NOTES);
    ok(JSON.stringify(p) === JSON.stringify(['208001', '273001']),
      `a clean address pin wins - the note is a fallback, never an override (got ${JSON.stringify(p)})`);
  }

  // ---- 3. an unattributable note yields nothing ----
  {
    // The origin pin IS present, but with no "Destination Address" marker to split on. Reading
    // any six digits here would stamp Kanpur's 209304 onto a Gorakhpur drop.
    const { pins: p } = await pins(REAL_POINTS,
      'Please call the site before loading. KANPUR - 209304. Handle with care.');
    ok(JSON.stringify(p) === JSON.stringify([]),
      `a note with no Destination Address marker attributes nothing (got ${JSON.stringify(p)})`);
  }

  // ---- 3b. both halves resolve when each carries a pin ----
  {
    const { pins: p } = await pins(REAL_POINTS,
      'Origin Address - KANPUR - 209304 + Destination Address- GORAKHPUR - 273001');
    ok(JSON.stringify(p) === JSON.stringify(['209304', '273001']),
      `both note halves resolve independently (got ${JSON.stringify(p)})`);
  }

  // ---- 3c. a destination-only pin never backfills the origin ----
  {
    const { pins: p } = await pins(REAL_POINTS,
      'Origin Address - no pin given + Destination Address- GORAKHPUR - 273001');
    ok(JSON.stringify(p) === JSON.stringify(['273001']),
      `a destination-only note pin does not backfill the origin (got ${JSON.stringify(p)})`);
  }

  // ---- empty / malformed inputs stay quiet ----
  {
    const a = await pins([], null);
    const b = await pins(REAL_POINTS, null);
    ok(JSON.stringify(a.pins) === JSON.stringify([]), 'no points and no notes renders no pins');
    ok(JSON.stringify(b.pins) === JSON.stringify([]), 'null notes does not throw and renders no pins');
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
