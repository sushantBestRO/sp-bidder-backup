'use strict';
/**
 * THE PRICE ASK NAMES THE NUMBER THE DESK WORKS BY.
 *
 * THE DEFECT THIS PINS. The ask carried one identifier - the portal's own enquiry key - and that is
 * not the number BRL's pricing desk works by. The client settled which is which himself, against
 * Best Roadways' own GoComet notification: it renders `Name:-3260108709 (260812UTJG)`, and "the one
 * next to the name, you see OA number, and the one in brackets is the Go commet ID number". The OA
 * value was already fetched, already mapped, already snapshotted onto the request and already
 * rendering on the /price page - it reached src/notify/ not at all. So this is one held field
 * arriving at one more surface, and the whole risk is in HOW it is written.
 *
 * WHAT IT MUST NOT DO, which is most of what is asserted below:
 *   verbatim   the value is rendered character for character. The client's example is a clean
 *              ten-digit number; real captured values are `3262511465-5601270693 (E.com)` and
 *              `3260108996-10-12/08`. Nothing splits on the hyphen, strips the suffix or extracts
 *              "just the number" - a wrong OA number in front of a pricer is worse than none, and
 *              a substring assertion would let a truncated render pass, so every check here is an
 *              equality against the input.
 *   both       the portal key stays. The client asked for both and asked to tell them apart, so the
 *              OA gets its own anchor and its own label rather than sharing the 🆔 line.
 *   SP intact  SuperProcure publishes no such field. The line is gated on the FIELD being present,
 *              never on a portal name, and the SuperProcure ask is asserted byte for byte.
 *   no leak    the CSV / XLSX exports are what an analyst reconciles against the portal's own
 *              report. A display field must not reach a cell.
 *
 *   node scripts/test-ask-oa-number.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ask-oa-'));

const assert = require('assert');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier } = require('../src/notify/notifier');
const { MemoryStore } = require('../src/store');
const { renderMessage } = require('../src/notify/waTemplates');
const exportModel = require('../src/web/exportModel');
const { toXlsx } = require('../src/web/xlsx');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

// The three shapes this field really takes. The first is the client's own example; the other two
// are captured values off live enquiries. They are deliberately awkward - a hyphenated compound
// with a parenthesised suffix, and one carrying a slash date - because a tidied test value is
// exactly what would let a "clean it up first" regression through.
const SHAPES = ['3260108709', '3262511465-5601270693 (E.com)', '3260108996-10-12/08'];

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

// A GoComet load off the Director's own 2026-08-12 screenshot, plus the reference under test.
const gcLoad = (id, shipperRef) => ({
  id,
  lane: { origin: 'Tal-Chikhli', destination: 'Degam' },
  laneParsed: {
    origin: { city: 'Tal-Chikhli', label: 'Tal-Chikhli', pin: '396521' },
    destination: { city: 'Degam', label: 'Degam', pin: '396530' },
  },
  equipment: '40 ft, 22 T', units: 187, weight: 22, weightUnit: 'MT',
  companyName: 'Waaree Energies Ltd.', closesAt: now + 30 * 60_000, status: 'live',
  shipperRef,
});

// SuperProcure: a city per lane end, and no shipperRef anywhere on the record.
const spLoad = (id, over) => Object.assign({
  id, lane: { origin: 'Vejalpur', destination: 'CBD BELAPUR' },
  equipment: 'AP: Truck flat 9 ton-Open Body', units: 1, weight: 9, weightUnit: 'MT',
  companyName: 'SIKA India', branchName: 'Vejalpur - Toll (IN04)',
  closesAt: now + 30 * 60_000, status: 'live',
  points: [
    { kind: 'pickup', address: 'SIKA INDIA PVT LTD, Vejalpur, Gujarat 389340, IN' },
    { kind: 'drop', address: 'CBD BELAPUR, Navi Mumbai, Maharashtra 400614, IN' },
  ],
}, over);

/** The OA line's VALUE - everything after the label - or null when the line is absent. */
const oaValue = (msg) => {
  const m = /^\u{1F516} \*OA\* - (.*)$/mu.exec(msg);
  return m ? m[1] : null;
};
const lines = (msg) => msg.split('\n');

(async () => {
  const { requests } = require('../src/web/server');

  const tr = mockTransport();
  const notifier = new Notifier({
    mode: 'whatsapp', platformModes: { sp: 'whatsapp', gocomet: 'whatsapp' },
    baseUrl: 'http://h', log: () => {}, store: new MemoryStore(),
    wa: new WhatsAppClient({ ...CREDS, enabled: true, transport: tr }),
    recipientsProvider: async () => recipients,
  });
  const ask = async (load, platformKey) => {
    const rec = await requests.createForLoad(load, { deadlineAt: now + 28 * 60_000, platformKey });
    await notifier.requestPrice(rec);
    return tr.calls[tr.calls.length - 1].body.message;
  };

  // ---- 1. THE VALUE SURVIVES THE WHOLE PATH, CHARACTER FOR CHARACTER --------------------------
  // End to end over the real notifier, not a direct renderMessage call: the field has to survive
  // the load snapshot, _priceNeededData and the template, and the reported defect was a break in
  // that path rather than in the template.
  console.log('\n1. every real shape reaches the desk whole');
  {
    for (const ref of SHAPES) {
      const msg = await ask(gcLoad(`GC-OA-${SHAPES.indexOf(ref)}`, ref), 'gocomet');
      assert.strictEqual(oaValue(msg), ref,
        `the OA value is rendered verbatim (sent ${JSON.stringify(ref)}, rendered ${JSON.stringify(oaValue(msg))})`);
      ok(true, `${JSON.stringify(ref)} renders character for character`);
    }
    // Equality above already forbids truncation, but say the failure modes out loud: these are the
    // three things a "helpful" parse would produce, and each would still contain a real substring.
    const compound = await ask(gcLoad('GC-OA-WHOLE', SHAPES[1]), 'gocomet');
    ok(oaValue(compound) !== '3262511465' && oaValue(compound) !== '3262511465-5601270693',
      'the compound value is never split on its hyphen nor stripped of its suffix');
    const dated = await ask(gcLoad('GC-OA-DATED', SHAPES[2]), 'gocomet');
    ok(oaValue(dated) !== '3260108996' && oaValue(dated).endsWith('12/08'),
      'and a value carrying a slash date keeps the whole tail rather than reading as a number plus noise');
  }

  // ---- 2. BOTH IDENTIFIERS, AND THEY ARE TELLABLE APART ---------------------------------------
  console.log('\n2. the OA and the portal key are both there, and distinguishable');
  {
    const msg = await ask(gcLoad('2608125T8R', SHAPES[0]), 'gocomet');
    const oa = lines(msg).findIndex((l) => l.startsWith('\u{1F516}'));
    const key = lines(msg).findIndex((l) => l.startsWith('\u{1F194}'));
    ok(oa >= 0 && key >= 0, 'the ask carries two identifier lines, not one');
    ok(oa < key, 'the OA leads and the portal key sits under it - the order the client\'s own portal notification uses');
    ok(lines(msg)[key] === '\u{1F194} 2608125T8R',
      'the portal-key line is untouched - the OA was added beside it, never over it');
    ok(lines(msg)[oa].includes('*OA*'),
      'the OA line is labelled, so the two numbers cannot be read as one field split across lines');
    // "OA No" already exists in this catalogue - on the won / lost / no_bid receipts - and it
    // renders the PLATFORM LOAD ID there (engineAlerts sets oaNo: evt.auctionId). Reusing it would
    // put one label on two different numbers for the same load, so this line says "OA", which is
    // the client's own word and what the /price page prints.
    ok(!lines(msg)[oa].includes('OA No'),
      'and it does NOT borrow the receipts\' "OA No" label, which renders a different number');
  }

  // ---- 3. NO FIELD, NO LINE - never a stranded label -------------------------------------------
  console.log('\n3. a load with no reference gets no line at all');
  {
    const bare = await ask(gcLoad('GC-NOREF', null), 'gocomet');
    ok(oaValue(bare) === null, 'no OA line renders when the portal published no reference');
    ok(!bare.includes('OA') && !bare.includes('\u{1F516}'),
      'and no stranded label with nothing after it - the line is omitted, not emptied');
    for (const empty of ['', '   ']) {
      const m = await ask(gcLoad(`GC-EMPTY-${empty.length}`, empty), 'gocomet');
      ok(oaValue(m) === null, `a ${empty === '' ? 'blank' : 'whitespace-only'} reference is treated as absent, not printed`);
    }
  }

  // ---- 4. SUPERPROCURE IS BYTE-UNCHANGED -------------------------------------------------------
  console.log('\n4. the SuperProcure ask did not move');
  {
    const msg = await ask(spLoad('SP-1'), 'sp');
    // The whole message, pinned as a literal. This is the byte assertion: any change to the ask's
    // shape - a new line, a moved label, a stray space - fails here rather than being absorbed by
    // a substring check. Only the /price link's token varies per request, so it is the one part
    // matched by pattern.
    const expected = [
      '\u{1F4E9} *SIKA India · Vejalpur - Toll (IN04)*',
      '\u{1F194} SP-1',
      '\u{1F4CD} *From* - Vejalpur 389340',
      '\u{1F3AF} *To* - Cbd Belapur 400614',
      '\u{1F69B} 1 x AP: Truck flat 9 ton-Open Body . 9 MT',
      `\u{23F0} ${require('../src/notify/waTemplates').fmtCloseWithCutoff(now + 30 * 60_000, now + 28 * 60_000)}`,
      '',
      null, // the link line
    ];
    const got = lines(msg);
    ok(got.length === expected.length, `the SuperProcure ask is still ${expected.length} lines (got ${got.length})`);
    for (let i = 0; i < expected.length; i += 1) {
      if (expected[i] === null) continue;
      assert.strictEqual(got[i], expected[i], `SuperProcure ask line ${i + 1}`);
    }
    ok(true, 'and every line of it is byte-identical to the shape that shipped before this change');
    ok(/^\u{1F449} http:\/\/h\/price\/\S+$/u.test(got[7]), 'including the link line, still the last thing in the message');
    ok(oaValue(msg) === null && !msg.includes('\u{1F516}'),
      'no OA line anywhere on it - SuperProcure publishes no such field');
  }

  // ---- 5. THE GATE IS THE FIELD, NEVER THE PORTAL NAME ------------------------------------------
  console.log('\n5. the line is decided by the data, not by which portal sent it');
  {
    // A SuperProcure-tagged record that DOES carry the field must render the line. If this fails,
    // the gate has become a portal-name test - the house pattern this codebase deliberately avoids,
    // because it makes every future portal a code change instead of a data change.
    const spWithRef = await ask(spLoad('SP-REF', { shipperRef: SHAPES[0] }), 'sp');
    assert.strictEqual(oaValue(spWithRef), SHAPES[0]);
    ok(true, 'a SuperProcure record carrying a reference renders the OA line - capability, not portal name');

    // And the mirror: a GoComet record WITHOUT one renders none (asserted in 3, restated here as
    // the other half of the pair so the two cases read as one property).
    const gcNoRef = await ask(gcLoad('GC-PAIR', null), 'gocomet');
    ok(oaValue(gcNoRef) === null && oaValue(spWithRef) !== null,
      'so the two portals differ only where their DATA differs, never by name');
  }

  // ---- 6. THE TEMPLATE ADDS A LINE AND CHANGES NOTHING ELSE ------------------------------------
  console.log('\n6. the added line is the only difference');
  {
    // Rendered directly off the catalogue against one payload with and without the field, so the
    // claim "nothing else moved" is checked on identical data rather than on two different loads.
    const base = {
      shipperName: 'Waaree Energies Ltd.', branch: 'Surat', name: 'GC-1', loadCode: '',
      laneFrom: 'Tal-Chikhli 396521', laneTo: 'Degam 396530',
      cargo: '187 x 40 ft, 22 T', weight: 22, weightUnit: 'MT',
      closesText: '12-08-2026 05:10 PM (enter cost by 05:08 PM)', link: 'http://h/price/x',
    };
    const without = renderMessage('price_needed', base);
    const with_ = renderMessage('price_needed', { ...base, shipperRef: SHAPES[1] });
    assert.strictEqual(lines(with_).filter((l) => !l.startsWith('\u{1F516}')).join('\n'), without,
      'removing the OA line from the new render reproduces the old one exactly');
    ok(true, 'the OA line is purely additive - every other line, blank line and slot is untouched');
    ok(lines(with_).length === lines(without).length + 1, 'exactly one line was added, not two');
  }

  // ---- 7. NOTHING LEAKED INTO THE EXPORTS -------------------------------------------------------
  console.log('\n7. the exports are byte-unchanged');
  {
    // The ask and the exports read the SAME stored record. The export columns are what an analyst
    // reconciles against the portal's own report, so a display field must not appear in one - and
    // the xlsx bytes are compared, not just the CSV text, because the two are projected from one
    // rows array and a leak into it would reach both.
    const datasets = await exportModel.buildDatasets({ requests, bidLogger: { listClosed: async () => [] } });
    const view = exportModel.VIEWS.funnel;
    const { headers, rows, numericColumns } = view.project(datasets.funnel);
    const flat = JSON.stringify(rows);
    ok(SHAPES.every((s) => !flat.includes(s)),
      'no OA value reached any funnel cell, on any of the three shapes');
    ok(!headers.includes('OA') && !headers.some((h) => /OA/.test(h)),
      'and no OA column was invented - the export schema is unchanged');
    const asBuilt = toXlsx({ sheetName: view.sheet, headers, rows, numericColumns });
    const stripped = toXlsx({
      sheetName: view.sheet,
      headers,
      rows: rows.map((r) => r.map((c) => (typeof c === 'string' && SHAPES.includes(c) ? '' : c))),
      numericColumns,
    });
    ok(Buffer.compare(asBuilt, stripped) === 0,
      `the .xlsx bytes are identical to a workbook with every OA value blanked out (${asBuilt.length} bytes) - so none was in it`);
  }

  // COMPLETION SENTINEL. run-tests.js grades a file by EXIT STATUS ONLY, so a file that returns
  // early - an unref'd timer, an early return, a swallowed rejection - exits 0 having asserted
  // nothing and is scored a pass. Pinning the count makes a vacuous green impossible.
  const EXPECTED_CHECKS = 25;
  const ran = pass + fail;
  if (ran !== EXPECTED_CHECKS) {
    console.error(`  FAIL - completion sentinel: ran ${ran} checks, expected ${EXPECTED_CHECKS}`);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  console.log(`\n${pass} passed, ${fail} failed (${ran}/${EXPECTED_CHECKS} checks reached the sentinel)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e && e.stack || e); process.exit(1); });
