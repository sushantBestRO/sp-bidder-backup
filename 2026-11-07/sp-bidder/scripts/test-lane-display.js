'use strict';
/**
 * ONE lane, written ONE way, whichever portal it came from.
 *
 * THE DEFECT THIS PINS. The console rendered whatever each adapter happened to emit, so two
 * portals' rows sat side by side in the same worklist in four visibly different shapes: one
 * carried a state and the other did not, one shouted its city in caps while the next row did not,
 * an address the parser declined dumped a company name, a postal address and a mobile number into
 * a table cell, and the full-address follow-on rows appeared under one portal's rows only. Three
 * of those four are not styling at all - they are two portals reaching the renderer in different
 * shapes with nothing in between to reconcile them, which is why fixing the symptom on one screen
 * kept leaving it live on the next and why a third portal would have arrived as a third shape.
 *
 * So the assertions below are deliberately written as EQUALITIES BETWEEN THE PORTALS rather than
 * as expected strings per portal. A future adapter that emits its lane in some fifth shape must
 * fail this file, and it cannot be made to pass by tuning one portal's output to match a literal.
 *
 * Addresses are real strings off the live board, not tidied inventions - the whole failure mode is
 * real data being uglier than test data.
 *
 *   node scripts/test-lane-display.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir + grep gate), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-lane-display-'));

const http = require('http');
const { canonicalPlace, withLaneDisplay, MAX_LABEL } = require('../src/web/laneDisplay');
const { parseGoCometLane } = require('../src/platform/gocometLane');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET' },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, text: b })); });
    r.on('error', reject);
    r.end();
  });
}

// ---- real lane ends, verbatim -----------------------------------------------------------------

// SuperProcure publishes a city, in whatever case the branch typed it, sometimes with its own
// two-letter state suffix. All four of these sat on one board on one day.
const SP_SHOUTED = 'UDHAMPUR';
const SP_CASED = 'Sikandrabad';
const SP_STATED = 'Bawal, HR';
const SP_PLAIN = 'Supaul';

// GoComet publishes no city field at all - the whole postal address is the lane value.
const GC_DEGAM = 'Survey No. 1934, NH-48, Near Darshan Hotel, Village # Degam, Taluka # Chikhli, Degam-396530, Gujarat';
// The destination the desk screenshotted: consignee, contact, full address and a mobile number in
// a table cell. It carries a pincode, and the state sits where every other row puts the city.
const GC_SUNSHINE = 'M/S SUNSHINE ENTERPRISES Tejasvini Praful Soni Hedgewar nagar, DHARANGAON, DHARANGAON, MAHARASHTRA, 425105,IN MOB:8669148300';
// The genuinely unreadable shape: a mobile number welded to the city with single spaces, so the
// parser correctly declines rather than printing a phone number as a place.
const GC_UNREADABLE = 'M/S Rudransh Electrical Gut No 13 Plot No 22, Ram Nagar Kautha Nanded Waghala (M Corp), Navin Bridge, Nanded, Santoshi Mata MOB:8866950131 Nanded-431603';

const now = Date.now();
const baseLoad = (id, lane, extra) => Object.assign({
  id, lane, equipment: '32ft SXL', units: 1, companyName: 'Waaree Energies Ltd.',
  closesAt: now + 30 * 60_000, startsAt: now - 60_000, status: 'live', closeModelKnown: true,
}, extra);

const gcLoad = (id, origin, destination, opts) => baseLoad(id, { origin, destination }, {
  laneParsed: (opts && opts.preParser) ? null
    : parseGoCometLane({ origin, destination, origin_zip_code: null, destination_zip_code: null }),
});

const spLoad = (id, origin, destination) => baseLoad(id, { origin, destination }, {
  points: [
    { kind: 'pickup', address: `Havells India Ltd., ${origin}, Jammu and Kashmir 182101, IN` },
    { kind: 'drop', address: `Warehouse 7, ${destination}, Bihar 852131, IN` },
  ],
});

const hasComma = (s) => s.includes(',');
const isTitleCased = (s) => !/\b[A-Z]{2,}\b/.test(s) && !/\b[a-z]/.test(s.charAt(0));

(async () => {
  const { app, requests } = require('../src/web/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const seed = async (load, platformKey) => (await requests.createForLoad(load,
    { deadlineAt: now + 28 * 60_000, platformKey })).id;

  await seed(spLoad('SP-1', SP_SHOUTED, SP_PLAIN), 'sp');
  await seed(spLoad('SP-2', SP_CASED, SP_STATED), 'sp');
  const gcId = await seed(gcLoad('GC-1', GC_DEGAM, GC_SUNSHINE), 'gocomet');
  await seed(gcLoad('GC-2', GC_DEGAM, GC_UNREADABLE), 'gocomet');
  await seed(gcLoad('GC-3', GC_DEGAM, GC_SUNSHINE, { preParser: true }), 'gocomet');

  const list = JSON.parse((await get(`${base}/api/price-requests`)).text);
  const row = (id) => list.requests.find((x) => x.loadId === id);
  const disp = (id) => row(id).load.laneDisplay;
  const ends = (id) => [disp(id).origin, disp(id).destination];
  const allEnds = ['SP-1', 'SP-2', 'GC-1', 'GC-2', 'GC-3'].flatMap(ends);

  // ---- 1. THE STATE. Neither portal carries one, and that is asserted across both at once ------
  {
    ok(disp('GC-1').origin === 'Degam',
      'a parsed address heads its cell with the city alone, not "City, State"');
    ok(disp('SP-2').destination === 'Mundra' || disp('SP-2').destination === 'Bawal'
      || !hasComma(disp('SP-2').destination),
      'a portal that appends its own two-letter state code has it stripped the same way');
    ok(allEnds.filter((e) => hasComma(e)).length === 0,
      'NO lane end on EITHER portal carries a state - the rule is one rule, not one per portal');
    // The state is not lost, it moved: the full address under the row still carries it.
    ok(disp('GC-1').points.some((p) => /MAHARASHTRA/i.test(p.address)),
      'the state it dropped is still on screen, in the full address beneath the row');
    ok(disp('SP-2').points.some((p) => /Bihar|Jammu/i.test(p.address)),
      'and the same is true on the other portal - dropping it costs neither of them the fact');
  }

  // ---- 2. THE UNPARSED DUMP. Bounded, always, whatever the parse did --------------------------
  {
    const d = disp('GC-2').destination;
    ok(d.length <= MAX_LABEL + 3,
      `an address the parser declines is BOUNDED (${d.length} chars, cap ${MAX_LABEL} + an ellipsis)`);
    ok(d.endsWith('...'), 'and says so, rather than looking like the whole value');
    ok(!/MOB:/.test(d) && !/\d{6}/.test(d),
      'so neither a mobile number nor a pincode reaches a table column');
    ok(disp('GC-2').points.some((p) => p.address.includes('MOB:8866950131')),
      'the FULL string is still on screen underneath - bounding is only safe because of this row');
    ok(allEnds.every((e) => e.length <= MAX_LABEL + 3),
      'and no lane end anywhere, on either portal, is unbounded');
  }

  // ---- 3. THE SUB-ROWS. Same rows under both portals ------------------------------------------
  {
    const kinds = (id) => disp(id).points.map((p) => p.kind).join('+');
    ok(kinds('SP-1') === 'pickup+drop', 'a portal that publishes a points array fills Pickup and Drop');
    ok(kinds('GC-1') === 'pickup+drop',
      'a portal that publishes NO points array fills the SAME two rows from the addresses it does publish');
    ok(kinds('GC-3') === 'pickup+drop', 'including a record stored before any of this existed');
    ok(disp('SP-1').points[0].address.includes('Havells India Ltd.'),
      'the portal\'s own points are used verbatim where it published them');
    ok(disp('GC-1').points[0].address.includes('Near Darshan Hotel')
      && disp('GC-1').points[1].address.includes('SUNSHINE ENTERPRISES'),
      'and the raw lane addresses fill them where it did not - nothing is invented, only reshaped');
  }

  // ---- 3b. AND WHICH OF THOSE SUB-ROWS SAY ANYTHING -------------------------------------------
  // A synthesised entry repeats its own lane end whenever the lane string was already a place
  // name, so the console's Lane cell drops it and prints the label alone. `echoesLaneEnd` is
  // decided here rather than by comparing strings on the surface, because the label has had a
  // trailing state stripped: a console-side comparison sees "Bawal" against "Bawal, HR", calls
  // them different, and keeps every state-suffixed row - which is exactly the bug this pins.
  {
    const echoes = (id) => disp(id).points.map((p) => !!p.echoesLaneEnd).join('+');
    ok(echoes('GC-1') === 'false+false',
      'a synthesised entry that IS the full postal address keeps its row - the addresses on a '
      + 'portal that publishes no points array are the only place they appear');
    ok(echoes('SP-1') === 'false+false',
      'and a point the PORTAL published is never flagged, whatever it happens to look like');

    const stated = withLaneDisplay({ lane: { origin: 'Bawal, HR', destination: 'Dahej' }, points: null });
    ok(stated.laneDisplay.origin === 'Bawal' && stated.laneDisplay.points[0].address === 'Bawal, HR',
      'precondition: the label strips the state suffix the synthesised address keeps');
    ok(stated.laneDisplay.points.every((p) => p.echoesLaneEnd),
      'so a state-suffixed lane end is flagged as an echo, NOT compared string-to-string against '
      + 'its own stripped label');
    ok(withLaneDisplay({ lane: { origin: 'Govindgarh', destination: 'Thane' }, points: null })
      .laneDisplay.points.every((p) => p.echoesLaneEnd),
      'as is the plain-city case that has no suffix to strip');
  }

  // ---- 4. THE CASING -------------------------------------------------------------------------
  {
    ok(disp('SP-1').origin === 'Udhampur', 'a shouted city is title-cased');
    ok(disp('SP-2').origin === SP_CASED, 'a city the source already cased is left exactly alone');
    ok(allEnds.every(isTitleCased),
      'and every end on both portals reads the same way - no row shouts at the row above it');
  }

  // ---- 5. THE ADDRESS THE DESK SCREENSHOTTED ---------------------------------------------------
  {
    ok(disp('GC-1').destination === 'Dharangaon',
      'the screenshotted destination now reads as a city: the state sat in the segment a city '
      + 'normally occupies, and a state is not a city');
    ok(disp('GC-3').destination === disp('GC-1').destination,
      'a record stored before the parser existed reads identically - it is derived on read');
    ok(canonicalPlace('DHARANGAON, MAHARASHTRA') === 'Dharangaon',
      'and a trailing state is stripped even when the parser handed one over');

    // WHICH SOURCE IS AUTHORITATIVE: the parser's structured `city`, not its composed "City, State"
    // label with the state taken back off again. On every real address today the two agree, which
    // is exactly why this one parse is SYNTHETIC rather than captured - the point is that a label
    // growing a part it does not have today cannot leak one into a lane cell.
    const synthetic = withLaneDisplay({
      lane: { origin: 'raw', destination: 'raw' },
      laneParsed: {
        origin: { city: 'Rajkot', state: 'Gujarat', pincode: '360005', label: 'Rajkot, Gujarat, India' },
        destination: { city: 'Rajkot', state: 'Gujarat', pincode: '360005', label: 'Rajkot, Gujarat, India' },
      },
    });
    ok(synthetic.laneDisplay.origin === 'Rajkot',
      'the structured city is read directly - a composed label is never re-parsed to get back to it');
  }

  // ---- 6. ONE RULE: the page and the payload cannot disagree ------------------------------------
  {
    const html = (await get(`${base}/price/${gcId}`)).text;
    const head = /<div class="slane">([\s\S]*?)<\/div>\s*<div class="sgrid">/.exec(html);
    ok(!!head && head[1].includes('Degam') && head[1].includes('Dharangaon'),
      'the price page heads the card with exactly the strings the worklist shows');
    ok(!head[1].includes('Survey No.') && !head[1].includes('MOB:'),
      'and neither postal blob reaches it');
    ok(/<span class="sk">Pickup<\/span>/.test(html) && /<span class="sk">Drop<\/span>/.test(html),
      'and it fills the same Pickup/Drop rows from the same list');
  }

  // ---- 7. DISPLAY ONLY: the stored record is untouched ------------------------------------------
  {
    const stored = await requests.getByToken(gcId);
    ok(stored.load.lane.origin === GC_DEGAM && stored.load.lane.destination === GC_SUNSHINE,
      'lane stays the portal\'s raw strings - the allowlist, the durable intent and route history '
      + 'are all keyed on them and a display value leaking in would silently re-scope them');
    ok(stored.load.laneDisplay == null, 'and nothing is written back to the store');
    ok(row('GC-1').load.points == null,
      'the synthesised addresses do NOT reach load.points, which lanePins, the WhatsApp ask, the '
      + 'bid log and the CSV exports all read as "what the portal actually gave us"');
  }

  // ---- 8. THE GATE that stops this being re-implemented client-side -----------------------------
  {
    const walk = (dir, out = []) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (/\.(js|ts|tsx)$/.test(e.name)) out.push(p);
      }
      return out;
    };
    const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

    // The console must never see the PARSED structure. It reads composed strings or nothing:
    // the old divergence was api.ts preferring `laneParsed[end].label` where the server preferred
    // `.city`, which is only possible because the client could reach the parts at all.
    const parsedLeaks = walk(path.join(ROOT, 'dashboard', 'src'))
      .filter((f) => fs.readFileSync(f, 'utf8').includes('laneParsed')).map(rel);
    ok(parsedLeaks.length === 0,
      `the console never touches laneParsed - it renders what the server composed (saw: ${parsedLeaks.join(', ') || 'none'})`);

    // And the rule itself has exactly one definition to change.
    const ruleFiles = [path.join(ROOT, 'src'), path.join(ROOT, 'dashboard', 'src')]
      .flatMap((d) => walk(d))
      .filter((f) => fs.readFileSync(f, 'utf8').includes('INDIAN_STATE_CODES')).map(rel);
    ok(ruleFiles.length === 1 && ruleFiles[0] === 'src/web/laneDisplay.js',
      `the display rule is defined in exactly one file (saw: ${ruleFiles.join(', ') || 'none'})`);
  }

  server.close();

  // COMPLETION SENTINEL. run-tests.js grades a file by EXIT STATUS ONLY, so a file that returns
  // early - an unref'd timer, an early return, a swallowed rejection - exits 0 having asserted
  // nothing and is scored a pass. Pinning the count makes a vacuous green impossible.
  const EXPECTED_CHECKS = 35;
  const ran = pass + fail;
  if (ran !== EXPECTED_CHECKS) {
    console.error(`  FAIL - completion sentinel: ran ${ran} checks, expected ${EXPECTED_CHECKS}`);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  console.log(`\n${pass} passed, ${fail} failed (${ran}/${EXPECTED_CHECKS} checks reached the sentinel)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
