'use strict';
/**
 * GoComet lane parsing - city/state/pincode out of a portal that publishes neither a city nor a
 * state field, only a free-text postal address and a pincode.
 *
 * EVERY ADDRESS BELOW IS REAL. They come from the 2026-08-04 HAR captures, the PR #185 fixture
 * (enquiry 2608115VVB), and a read-only probe of all 30 open enquiries on 2026-08-11. None is
 * hand-written, because the whole risk here is a parser tuned to invented strings: the portal's
 * real output carries six-space separator runs, literal wrapping double quotes, " # " where a
 * colon belongs, ", - " before the pincode, GSTIN/PAN tails after it, duplicated pincodes, and an
 * entirely different SAP-style shape where the city comes AFTER the pincode.
 *
 * THE BEHAVIOURAL RULE THIS PINS, above any individual city: parsing is cosmetic, surfacing is
 * not. Nothing in this module may throw, and an address it cannot read must degrade to the raw
 * string rather than to a guess - a load nobody can see is worse than a load with an ugly label,
 * and a confidently wrong city on a freight board is worse than a long one.
 */

const assert = require('assert');
const { parseGoCometPlace, parseGoCometLane, cleanAddress } = require('../src/platform/gocometLane');

const EXPECTED_CHECKS = 59;
let pass = 0; let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}`); }
}

// Real Waaree plant origin - " # " separators, city then pincode then state.
const DEGAM = 'Survey No. 1934, NH-48, Near Darshan Hotel, Village # Degam, Taluka # Chikhli, Degam-396530, Gujarat';

(async () => {
  // ---- A. the shapes the operator complained about ----
  {
    const p = parseGoCometPlace(DEGAM, '396530');
    ok(p.city === 'Degam', 'A: origin city read from the segment before the pincode');
    ok(p.state === 'Gujarat', 'A: state matched from the text after the pincode');
    ok(p.pincode === '396530', 'A: pincode taken from the portal field');
    ok(p.label === 'Degam, Gujarat', 'A: label is "City, State", not the survey-number blob');
    ok(!/#/.test(p.label), 'A: the " # " separator never reaches the label');

    // The consignee name concatenated into the destination - three different join styles, none
    // of which is a reliable separator, which is why the name is dropped positionally rather
    // than parsed off the front.
    const dash = parseGoCometPlace('ARHAM ENERGIES - Sy No. 6, Kasaba Hobali, Nelamangala Taluk,    Tumkur Road  Bangalore - 562123', '562123');
    ok(dash.city === 'Bangalore', 'A: consignee joined with " - " does not reach the city');
    ok(dash.label === 'Bangalore', 'A: no state in the string -> label is the bare city');

    const none = parseGoCometPlace('M/S AVNI SOLAR 10/532G, St Marys Building, Kanakkari, Kottayam-686632 Kerala', '686632');
    ok(none.city === 'Kottayam', 'A: consignee joined with no separator at all is still dropped');
    ok(none.state === 'Kerala', 'A: state with NO comma before it still matches');

    const comma = parseGoCometPlace('M/S Balaji Traders,192/115a, Prabhakar Nagar,Diwedi Marg,Bai ka Bagh,Prayagraj-211003,Uttar Pradesh', '211003');
    ok(comma.city === 'Prayagraj', 'A: consignee joined with a bare comma is still dropped');
    ok(comma.state === 'Uttar Pradesh', 'A: a two-word state matches');
  }

  // ---- B. the ugly source artefacts, each from a real row ----
  {
    const six = parseGoCometPlace('RAMA TECHNOLOGIES - 131, Shanti Nagar Yojna, Mogra Khurd,      Jodhpur - 342802', '342802');
    ok(six.city === 'Jodhpur', 'B: a six-space run is a separator, not part of the city');
    ok(!/ {2}/.test(six.label), 'B: whitespace runs are collapsed in the label');

    // "Patan, - 384285": a comma AND a dash before the pincode, with nothing between them.
    const artefact = parseGoCometPlace('SOLARCRAFT POWER INDIA 5 - Survey No 397/p1/p3,398/p3, Khata 590    Sarswati,Delvada,  Patan, - 384285', '384285');
    ok(artefact.city === 'Patan', 'B: the ", - " trailing artefact before the pincode is stripped');

    const quoted = parseGoCometPlace('"R. G. INDUSTRIES - airport road vill baluana,bathinda punjab Near luck plant 151001     BATHINDA IN     India           Region     03     Punjab INDIA"', '151001     ');
    ok(quoted.city === 'BATHINDA', 'B: SAP "Region" shape - the city is read AFTER the pincode');
    ok(quoted.state === 'Punjab', 'B: the Region-shape state is matched');
    ok(quoted.pincode === '151001', 'B: a zip field with trailing spaces is trimmed');
    ok(!/"/.test(quoted.label), 'B: literal wrapping double quotes never reach the label');

    // The mid-string "punjab" in "...bathinda punjab Near luck plant..." sits BEFORE the pincode
    // and must not be what matched - a street is not a state.
    const roadState = parseGoCometPlace('X ROAD, gujarat housing board, Bhiwandi - 421302', '421302');
    ok(roadState.state === null, 'B: a state word inside a street name does not become the state');
    ok(roadState.city === 'Bhiwandi', 'B: ...and the city is still read');

    // A pincode repeated in one address; the trailing occurrence is the canonical anchor.
    const dupe = parseGoCometPlace('"MAA KRIPA SOLAR - Soor Sagar Post Office Singhiyon Ki Gali RAJBAGH Jodhpur-342024 342024      Jodhpur IN     India           Region     08     Rajasthan INDIA"', '342024      ');
    ok(dupe.city === 'Jodhpur', 'B: a duplicated pincode anchors on the LAST occurrence');
    ok(dupe.state === 'Rajasthan', 'B: duplicated-pincode row still matches its state');

    // A GSTIN/PAN tail after the pincode is the case that kills "the state is whatever follows".
    const gstin = parseGoCometPlace('Survey No.644, Orpat Industrial Estate, Near Surajbar Bridge, Orpat Nagar, 8-A National Highway, Vandhia, Samakhiyali, Bhachau, Kutch - 370150 GSTIN :24ABDCS3684B1ZJ PAN :ABDCS3684B', '370150');
    ok(gstin.state === null, 'B: a GSTIN/PAN tail is NOT reported as the state');
    ok(gstin.city === 'Kutch', 'B: ...and the city before the pincode still reads');
    ok(!/GSTIN/.test(gstin.label), 'B: the tax-number tail never reaches the label');

    // "State Code: Maharashtra" - a labelled field after the pincode.
    const labelled = parseGoCometPlace('M/S Rudransh Electrical Gut No 13, Nanded, Santoshi Mata MOB:8866950131 Nanded-431603, State Code: Maharashtra', '431603');
    ok(labelled.state === 'Maharashtra', 'B: a state behind a "State Code:" label still matches');

    // Junk "0, 0, 0," address lines are real and must not become the city.
    const zeros = parseGoCometPlace('SUMIT TRADERS - 0, 0, 0, SHUKLAHA, KACHAHARI ROAD,Mirzapur      Mirzapur - 231001', '231001');
    ok(zeros.city === 'Mirzapur', 'B: "0" address lines are skipped, and the doubled city collapses');
  }

  // ---- B2. the two anchoring gaps the desk's screenshot exposed ----
  {
    // Real destination off the live board. It carries a pincode, and the shipper wrote the STATE
    // in the segment where every other row writes the city.
    const SUNSHINE = 'M/S SUNSHINE ENTERPRISES Tejasvini Praful Soni Hedgewar nagar, DHARANGAON, DHARANGAON, MAHARASHTRA, 425105,IN MOB:8669148300';
    const p = parseGoCometPlace(SUNSHINE, '425105');
    ok(p.city === 'DHARANGAON', 'B2: a segment that IS a state is stepped over - a state is not a city');
    ok(p.city !== 'MAHARASHTRA', 'B2: ...and is never printed as one, which is the confidently-wrong case');

    // The zip FIELD and the ADDRESS can disagree, and the field is then not in the string at all.
    // Anchoring used to give up there, so an address plainly carrying a pincode parsed to nothing.
    const mismatched = parseGoCometPlace(SUNSHINE, '425001');
    ok(mismatched.city === 'DHARANGAON', 'B2: a zip field absent from the address falls back to the pincode IN it');
    ok(mismatched.pincode === '425001', 'B2: ...while the portal field is still what gets REPORTED as the pincode');
    ok(!mismatched.label.includes('MOB:'), 'B2: ...and the label is a city, not the whole postal string');

    // Stepping back stops at the first segment: an address that is only a state still yields it.
    const onlyState = parseGoCometPlace('Gujarat - 380001', '380001');
    ok(onlyState.city === 'Gujarat', 'B2: the step-back never walks off the front of the address');

    // A city that merely CONTAINS a state word is untouched - only a whole-segment match steps.
    const contains = parseGoCometPlace('Plot 4, Goa Velha, Panaji - 403005', '403005');
    ok(contains.city === 'Panaji', 'B2: only an EXACT whole-segment state match steps back');
  }

  // ---- C. FAIL SOFT - the rule that outranks every city above ----
  {
    // A phone number welded to the city with single spaces: unreadable, so it must fall back
    // rather than print "Santoshi Mata MOB:8866950131 Nanded" as a place.
    const unread = parseGoCometPlace('M/S Rudransh Electrical Gut No 13 Plot No 22, Ram Nagar Kautha Nanded Waghala (M Corp), Navin Bridge, Nanded, Santoshi Mata MOB:8866950131 Nanded-431603', '431603');
    ok(unread.city === null, 'C: an address that defeats the parser yields NO city');
    ok(unread.label.startsWith('M/S Rudransh Electrical'), 'C: ...and the label degrades to the raw address');
    ok(unread.pincode === '431603', 'C: ...while the pincode field is still reported');

    const noPin = parseGoCometPlace('Some Place With No Postcode At All', '');
    ok(noPin.city === null && noPin.pincode === null, 'C: no pincode anywhere -> nothing is invented');
    ok(noPin.label === 'Some Place With No Postcode At All', 'C: ...label is still the raw address');

    // A zip hint that is not a pincode must not be trusted as one.
    const badZip = parseGoCometPlace('Somewhere, Nashik - 422102', 'N/A');
    ok(badZip.pincode === '422102', 'C: a junk zip field falls back to the pincode in the string');
    const shortZip = parseGoCometPlace('Somewhere, Nashik', '4221');
    ok(shortZip.pincode === null, 'C: a non-six-digit zip field is refused, not padded');

    // Nothing throws. Ever. This is the surfacing invariant, not a style preference.
    for (const [a, z] of [[null, null], [undefined, undefined], ['', ''], [42, 42], [{}, []],
      ['   ', '   '], ['-,-,-', '000000'], ['"""', null]]) {
      let threw = false; let r = null;
      try { r = parseGoCometPlace(a, z); } catch (_) { threw = true; }
      ok(!threw && r && typeof r.label === 'string', `C: parse(${JSON.stringify(a)}) returns a label, never throws`);
    }
    let laneThrew = false;
    try { parseGoCometLane(null); parseGoCometLane({}); parseGoCometLane({ origin: 5 }); } catch (_) { laneThrew = true; }
    ok(!laneThrew, 'C: parseGoCometLane survives a null / empty / malformed enquiry');
  }

  // ---- D. the enquiry-level shape the adapter publishes ----
  {
    const lane = parseGoCometLane({
      origin: DEGAM, origin_zip_code: '396530',
      destination: 'PRABHU ENTERPRISES - M. G Road,    Near Aam Chap Petrol Pump  Pratapgarh - 312605',
      destination_zip_code: '312605',
    });
    ok(lane.origin.label === 'Degam, Gujarat', 'D: origin end parsed');
    ok(lane.destination.label === 'Pratapgarh', 'D: destination end parsed');
    ok(lane.origin.pincode === '396530' && lane.destination.pincode === '312605', 'D: both pincodes carried');

    // The two rows the operator quoted: identical left halves, now distinct on both ends.
    const a = parseGoCometLane({ origin: DEGAM, origin_zip_code: '396530', destination: 'ARHAM ENERGIES - Sy No. 6, Kasaba Hobali, Nelamangala Taluk,    Tumkur Road  Bangalore - 562123', destination_zip_code: '562123' });
    const b = parseGoCometLane({ origin: DEGAM, origin_zip_code: '396530', destination: 'PRABHU ENTERPRISES - M. G Road,    Near Aam Chap Petrol Pump  Pratapgarh - 312605', destination_zip_code: '312605' });
    ok(a.origin.label === b.origin.label && a.origin.label.length < 20, 'D: the shared plant origin collapses to one short label');
    ok(a.destination.label !== b.destination.label, 'D: the two rows now differ on the destination');
  }

  // ---- E. cleanAddress preserves the separator it must, collapses the rest ----
  {
    ok(cleanAddress('"a b"') === 'a b', 'E: wrapping quotes stripped');
    ok(cleanAddress('Village # Degam') === 'Village Degam', 'E: " # " becomes a plain space');
    ok(/ {2}/.test(cleanAddress('Road  City')), 'E: internal 2-space runs SURVIVE cleaning (they are the separator)');
    ok(cleanAddress(null) === '' && cleanAddress(undefined) === '', 'E: null/undefined clean to empty');
  }

  // ---- completion sentinel ----
  // scripts/run-tests.js grades by EXIT CODE only, so an early return or a swallowed throw would
  // otherwise exit 0 as a green zero-assertion run. Assert the count that actually executed.
  assert.strictEqual(fail, 0, `${fail} GoComet lane-parse checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - the file exited early or a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
