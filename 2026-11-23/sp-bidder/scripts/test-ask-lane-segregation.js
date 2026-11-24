'use strict';
/**
 * THE PRICE ASK NAMES TWO PLACES, AND THE DESK CAN TELL WHICH IS WHICH.
 *
 * THE DEFECT THIS PINS. #196 put every lane end on one rule and applied it to the price page and
 * the console worklist. It deliberately left the WhatsApp ask byte-unchanged, and the ask is the
 * surface the pricing desk reads FIRST. On SuperProcure that was invisible, because the portal
 * publishes a city; on GoComet the portal publishes no city field at all, so the ask's single lane
 * line arrived as two full postal addresses run together and the Director asked, verbatim, "can you
 * check where the from and to locations are in this?" and "can you segregate the locations?".
 *
 * So the assertions below are written as EQUALITIES BETWEEN THE PORTALS wherever the claim is about
 * shape, the same discipline scripts/test-lane-display.js uses. A future portal that renders its
 * ask in some third shape must fail this file, and it must not be possible to make it pass by
 * tuning one portal's output to match a literal. The literals that DO appear are the ones a human
 * has to read: the exact rendered lines for a real load off the live board.
 *
 * What this pins:
 *   1. segregation  - two labelled lines, same labels in the same order on both portals, each
 *                     short enough to read on a phone without expanding the bubble.
 *   2. the wall     - the raw postal address is GONE from the GoComet ask; the city + pin it
 *                     replaced identifies the same place, and the FULL address is still one tap
 *                     away on the /price page the message links to.
 *   3. old records  - a GoComet record stored BEFORE the parser existed renders identically to one
 *                     stored after it. Production records predate it; a fix that only worked on
 *                     new loads would fix nothing the desk is looking at today.
 *   4. degradation  - an address the parser declines is BOUNDED, not dumped raw.
 *   5. agreement    - the ask, the /price page and the console worklist name the same place for
 *                     the same load, on both portals. That agreement IS the deliverable.
 *   6. the export   - the CSV/XLSX lane cells are the portal's RAW strings, byte for byte. The
 *                     ask and the export read the same stored record, and display formatting must
 *                     not follow the one into the other.
 *
 * Addresses are real strings off the live board, not tidied inventions - the whole failure mode is
 * real data being uglier than test data.
 *
 *   node scripts/test-ask-lane-segregation.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ask-lane-'));

const http = require('http');
const assert = require('assert');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier } = require('../src/notify/notifier');
const { MemoryStore } = require('../src/store');
const { MAX_LABEL } = require('../src/web/laneDisplay');
const { parseGoCometLane } = require('../src/platform/gocometLane');
const exportModel = require('../src/web/exportModel');
const { toXlsx } = require('../src/web/xlsx');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

// ---- real lane ends, verbatim ------------------------------------------------------------------

// The Waaree load in the Director's screenshot (2026-08-12). Both ends are full postal addresses,
// because GoComet has no city field to publish.
const GC_FROM = 'Aspee Logipark, Survey No. 791/1 & 85P2, Village & Post - Balwada, Tal-Chikhli, Gujarat 396521';
const GC_TO = 'Survey No. 1934, NH-48, Near Darshan Hotel, Village # Degam, Taluka # Chikhli, Degam-396530, Gujarat';
// The genuinely unreadable shape: a mobile number welded to the city with single spaces, so the
// parser correctly declines rather than printing a phone number as a place.
const GC_UNREADABLE = 'M/S Rudransh Electrical Gut No 13 Plot No 22, Ram Nagar Kautha Nanded Waghala (M Corp), Navin Bridge, Nanded, Santoshi Mata MOB:8866950131 Nanded-431603';

// SuperProcure publishes a city, in whatever case the branch typed it, and its pin lives in the
// point address. Load 23534893 (SIKA), the same fixture scripts/test-lane-pincodes.js uses.
const SP_FROM = 'Vejalpur';
const SP_TO = 'CBD BELAPUR';

const now = Date.now();
const CREDS = { token: 't', productId: 'p', phoneId: '128023' };
const recipients = [{ name: 'Pricing Desk', phone: '+91 90000 00001', alerts: ['price_needed'] }];

function mockTransport() {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'mid-' + calls.length } }) };
  };
  fn.calls = calls;
  return fn;
}

const baseLoad = (id, lane, extra) => Object.assign({
  id, lane, equipment: '40 ft, 22 T', units: 1, weight: 22, weightUnit: 'MT',
  companyName: 'Waaree Energies Ltd.', closesAt: now + 30 * 60_000, status: 'live',
}, extra);

// `preParser` reproduces the production majority: a record written before #186 added the parser,
// so it carries no laneParsed at all and the field has to be derived at serve time.
const gcLoad = (id, origin, destination, opts) => baseLoad(id, { origin, destination }, {
  laneParsed: (opts && opts.preParser) ? null
    : parseGoCometLane({ origin, destination, origin_zip_code: null, destination_zip_code: null }),
});

const spLoad = (id) => baseLoad(id, { origin: SP_FROM, destination: SP_TO }, {
  companyName: 'SIKA India', branchName: 'Vejalpur - Toll (IN04)',
  equipment: 'AP: Truck flat 9 ton-Open Body', weight: 9,
  points: [
    { kind: 'pickup', address: 'SIKA INDIA PVT LTD, Vejalpur, Gujarat 389340, IN' },
    { kind: 'drop', address: 'CBD BELAPUR, Navi Mumbai, Maharashtra 400614, IN' },
  ],
});

// The value written after a "<emoji> *<label>* - " prefix, or null when that line is absent.
const labelled = (msg, label) => {
  const m = new RegExp(`^\\S+ \\*${label}\\* - (.+)$`, 'm').exec(msg);
  return m ? m[1] : null;
};
// The lane lines' labels, in order. The SHAPE of the ask's lane block, with no values in it - what
// the cross-portal equalities below compare.
const laneLabels = (msg) => msg.split('\n').filter((l) => /^[\u{1F4CD}\u{1F3AF}]/u.test(l))
  .map((l) => l.split(' - ')[0]);
const stripPin = (s) => String(s).replace(/\s\d{6}$/, '');

function get(base, p) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET' },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, text: b })); });
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  const { app, requests } = require('../src/web/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const seed = (load, platformKey) => requests.createForLoad(load, { deadlineAt: now + 28 * 60_000, platformKey });

  // Both portals send through the mock so the two asks can be compared at all. Production routes
  // GoComet per its own platformMode - that gate is scripts/test-notify-platform-gating.js's
  // subject and is deliberately not re-asserted here.
  const tr = mockTransport();
  const notifier = new Notifier({
    mode: 'whatsapp', platformModes: { sp: 'whatsapp', gocomet: 'whatsapp' },
    baseUrl: 'http://h', log: () => {}, store: new MemoryStore(),
    wa: new WhatsAppClient({ ...CREDS, enabled: true, transport: tr }),
    recipientsProvider: async () => recipients,
  });
  const ask = async (record) => {
    await notifier.requestPrice(record);
    return tr.calls[tr.calls.length - 1].body.message;
  };

  const gcRec = await seed(gcLoad('GC-1', GC_FROM, GC_TO), 'gocomet');
  const gcOldRec = await seed(gcLoad('GC-2', GC_FROM, GC_TO, { preParser: true }), 'gocomet');
  const gcUglyRec = await seed(gcLoad('GC-3', GC_FROM, GC_UNREADABLE), 'gocomet');
  const spRec = await seed(spLoad('SP-1'), 'sp');

  const gcAsk = await ask(gcRec);
  const gcOldAsk = await ask(gcOldRec);
  const gcUglyAsk = await ask(gcUglyRec);
  const spAsk = await ask(spRec);

  // ---- 1. SEGREGATION, asserted across both portals at once -----------------------------------
  {
    assert.deepStrictEqual(laneLabels(gcAsk), laneLabels(spAsk),
      'the two portals label their lane ends identically');
    ok(laneLabels(gcAsk).length === 2,
      `each end gets its own labelled line (${laneLabels(gcAsk).join(' / ')})`);
    ok(labelled(gcAsk, 'From') && labelled(gcAsk, 'To') && labelled(spAsk, 'From') && labelled(spAsk, 'To'),
      'and both ends carry a value on both portals - never a labelled line with nothing after it');

    // The labels are the ones the won / lost / no_bid receipts already use, so the ask reads as the
    // same product rather than a new dialect.
    ok(gcAsk.includes('\u{1F4CD} *From* - ') && gcAsk.includes('\u{1F3AF} *To* - '),
      'the labels are the receipt templates\' own 📍 From / 🎯 To, not a new pair invented here');

    // Short enough to read at a glance. A cap that holds on BOTH portals is what stops one of them
    // quietly going back to a paragraph.
    const laneLineLen = (m) => m.split('\n').filter((l) => /^[\u{1F4CD}\u{1F3AF}]/u.test(l)).map((l) => l.length);
    const longest = Math.max(...laneLineLen(gcAsk), ...laneLineLen(spAsk), ...laneLineLen(gcUglyAsk));
    ok(longest <= 60, `no lane line on any portal runs past a phone's width (longest ${longest} chars)`);
  }

  // ---- 2. THE WALL OF TEXT IS GONE, and nothing it identified was lost ------------------------
  {
    ok(!gcAsk.includes(GC_FROM) && !gcAsk.includes(GC_TO),
      'neither raw postal address is in the GoComet ask any more - that pair IS the reported defect');
    ok(labelled(gcAsk, 'From') === 'Tal-Chikhli 396521' && labelled(gcAsk, 'To') === 'Degam 396530',
      `the ask names the same two places in a form that fits a bubble (${labelled(gcAsk, 'From')} / ${labelled(gcAsk, 'To')})`);
    ok(!gcAsk.includes('Gujarat') && !gcAsk.includes('Survey No.'),
      'no state, no plot number - the disambiguating detail is the pin, and the rest is on the page');
    ok(!spAsk.includes('SIKA INDIA PVT LTD') && !spAsk.includes('Maharashtra'),
      'and the SuperProcure ask still carries no full address either - the rule is one rule');

    // The full address is not deleted, it is one tap away. renderLoadCard fills these rows from the
    // same list laneDisplay composes, for the portal that publishes no points at all.
    const page = await get(base, `/price/${gcRec.id}`);
    ok(page.status === 200 && page.text.includes('Village &amp; Post - Balwada') && page.text.includes('Near Darshan Hotel'),
      'the WHOLE address is on the /price page this message links to - bounding the ask is only safe because of that');
  }

  // ---- 3. RECORDS STORED BEFORE THE PARSER EXISTED ---------------------------------------------
  {
    assert.strictEqual(labelled(gcOldAsk, 'From'), labelled(gcAsk, 'From'));
    assert.strictEqual(labelled(gcOldAsk, 'To'), labelled(gcAsk, 'To'));
    ok(gcOldRec.load.laneParsed == null,
      'the stored record genuinely carries no laneParsed - the production shape, not a decorated one');
    ok(true, 'and its ask reads identically to a post-parser record: the lane is derived at serve time, not migrated');
  }

  // ---- 4. AN ADDRESS THE PARSER DECLINES -------------------------------------------------------
  {
    const to = labelled(gcUglyAsk, 'To');
    ok(stripPin(to).length <= MAX_LABEL + 3,
      `an unparseable address is BOUNDED into the ask (${stripPin(to).length} chars, cap ${MAX_LABEL} + an ellipsis)`);
    ok(stripPin(to).endsWith('...'), 'and says so, rather than looking like the whole value');
    ok(!/MOB:/.test(to) && !to.includes(GC_UNREADABLE),
      'so a mobile number never reaches the desk\'s phone as a place name, and the raw string never lands whole');
  }

  // ---- 5. THE ASK, THE PAGE AND THE CONSOLE NAME THE SAME PLACE --------------------------------
  {
    const list = JSON.parse((await get(base, '/api/price-requests')).text);
    const disp = (loadId) => list.requests.find((x) => x.loadId === loadId).load.laneDisplay;

    for (const [loadId, msg] of [['GC-1', gcAsk], ['GC-2', gcOldAsk], ['SP-1', spAsk]]) {
      const d = disp(loadId);
      assert.strictEqual(stripPin(labelled(msg, 'From')), d.origin, `${loadId}: ask From === console origin`);
      assert.strictEqual(stripPin(labelled(msg, 'To')), d.destination, `${loadId}: ask To === console destination`);
    }
    ok(true, 'the ask and the console worklist write every lane end the same way, on both portals');

    // The page heads its card with the same strings, and the pin the ask appends is the pin the
    // page prints beneath it - one reader (laneDisplay.laneEndPins), not one per surface.
    const html = (await get(base, `/price/${spRec.id}`)).text;
    const head = /<div class="slane">([\s\S]*?)<\/div>\s*<div class="sgrid">/.exec(html);
    const pagePins = (h) => (String(h).match(/<div class="spin">(\d{6})<\/div>/g) || []).map((s) => s.match(/\d{6}/)[0]);
    ok(!!head && head[1].includes(stripPin(labelled(spAsk, 'From'))) && head[1].includes(stripPin(labelled(spAsk, 'To'))),
      'the /price page heads its card with exactly the two places the ask names');
    assert.deepStrictEqual(pagePins(html), ['389340', '400614']);
    ok(labelled(spAsk, 'From').endsWith('389340') && labelled(spAsk, 'To').endsWith('400614'),
      'and the ask carries the same two pins the page prints - one pin reader, not one per surface');

    const gcHtml = (await get(base, `/price/${gcRec.id}`)).text;
    assert.deepStrictEqual(pagePins(gcHtml), ['396521', '396530']);
    ok(labelled(gcAsk, 'From').endsWith('396521') && labelled(gcAsk, 'To').endsWith('396530'),
      'including on the portal whose pin comes from its own zip field rather than a point address');
  }

  // ---- 6. THE EXPORT IS BYTE-UNCHANGED ---------------------------------------------------------
  {
    // The ask and the export read the SAME stored record. The ask now formats its lane; the export
    // must not, because its Origin/Destination columns are what an analyst reconciles against the
    // portal's own report. The wall between them is that the export projects lane.origin /
    // lane.destination straight off canonical(), and nothing in laneDisplay is ever written back.
    const csv = (await get(base, '/api/export/funnel?format=csv')).text;
    ok(csv.includes(`"${GC_FROM}","${GC_TO}"`),
      'the funnel CSV carries the GoComet lane as the portal wrote it, comma-quoted and byte-identical');
    ok(csv.includes(`,${SP_FROM},${SP_TO},`),
      'and the SuperProcure lane in the portal\'s own casing - "CBD BELAPUR", not the display form');
    ok(!csv.includes(',Tal-Chikhli,') && !csv.includes(',Cbd Belapur,'),
      'no display value reached a cell on either portal');

    // toCsv and toXlsx are handed the SAME projected `rows` array by server.js, so pinning that
    // array pins both formats. Asserted through the xlsx writer's real bytes as well: rebuilding
    // the sheet from rows whose lane cells are forced to the raw strings produces an identical file.
    const datasets = await exportModel.buildDatasets({ requests, bidLogger: { listClosed: async () => [] } });
    const view = exportModel.VIEWS.funnel;
    const { headers, rows, numericColumns } = view.project(datasets.funnel);
    const O = exportModel.FUNNEL_HEADERS.indexOf('Origin');
    const D = exportModel.FUNNEL_HEADERS.indexOf('Destination');
    const gcRow = rows.find((r) => r[0] === 'GC-1');
    assert.strictEqual(gcRow[O], GC_FROM);
    assert.strictEqual(gcRow[D], GC_TO);
    const forced = rows.map((r) => r.slice());
    for (const r of forced) {
      if (r[0] === 'GC-1' || r[0] === 'GC-2') { r[O] = GC_FROM; r[D] = GC_TO; }
      if (r[0] === 'SP-1') { r[O] = SP_FROM; r[D] = SP_TO; }
    }
    const asBuilt = toXlsx({ sheetName: view.sheet, headers, rows, numericColumns });
    const asRaw = toXlsx({ sheetName: view.sheet, headers, rows: forced, numericColumns });
    ok(Buffer.compare(asBuilt, asRaw) === 0,
      `the .xlsx bytes are identical to a workbook built from the raw lane strings (${asBuilt.length} bytes)`);
  }

  server.close();

  // COMPLETION SENTINEL. run-tests.js grades a file by EXIT STATUS ONLY, so a file that returns
  // early - an unref'd timer, an early return, a swallowed rejection - exits 0 having asserted
  // nothing and is scored a pass. Pinning the count makes a vacuous green impossible.
  const EXPECTED_CHECKS = 22;
  const ran = pass + fail;
  if (ran !== EXPECTED_CHECKS) {
    console.error(`  FAIL - completion sentinel: ran ${ran} checks, expected ${EXPECTED_CHECKS}`);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  console.log(`\n${pass} passed, ${fail} failed (${ran}/${EXPECTED_CHECKS} checks reached the sentinel)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e && e.stack || e); process.exit(1); });
