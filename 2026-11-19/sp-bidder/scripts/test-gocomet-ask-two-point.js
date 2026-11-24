'use strict';
/**
 * BC-36: when a load has more than one pickup or drop point, the GoComet WhatsApp price ask says
 * so - never inventing an address.
 *
 * GoComet ships structured multi-point fields (`other_origins`/`other_destinations`), mapped by
 * gocometAdapter onto `otherOrigins`/`otherDestinations` as {city, pincode} pairs - see
 * test-gocomet-two-point-mapping.js for that half. This file pins the RENDERING precedence:
 * structured fields win when present; a load whose only signal is the shipper's own free text
 * ("(2 Point Delivery)"/"(2 Point Unloading)" in shipperRef, 2026-09-25 capture) says so in words;
 * a genuinely single-point load renders no extra line at all - the message is byte-identical to
 * before this feature existed.
 *
 * This calls the REAL renderMessage('price_needed', d), the same entry point notifier.js uses -
 * not a copy of the template string - so a future edit to the body or to twoPointLine/
 * laneDisplay.twoPointFacts is caught here.
 *
 *   node scripts/test-gocomet-ask-two-point.js
 */
const assert = require('assert');
const { renderMessage } = require('../src/notify/waTemplates');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const BASE = {
  shipperName: 'Waaree Energies Ltd.', branch: '', name: '2609192Q56', loadCode: '',
  laneFrom: 'Chikhli 396521', laneTo: 'Degam 396530',
  cargo: '1 x 32FTSXL', weight: 9, weightUnit: 'MT',
  closesText: '25-09-2026 03:30 PM (enter cost by 03:28 PM)', link: 'http://x/price/1',
};

(async () => {
  // ---- GC-2: structured two-point wins - city/pincode, never the street address, and an extra
  // DROP is never folded into the same line as an extra PICKUP (a mislabelled point changes the
  // route the desk prices) --------------------------------------------------------------------
  {
    const m = renderMessage('price_needed', {
      ...BASE,
      otherDestinations: [{ city: 'Hathras', pincode: '204101' }],
      shipperRef: '(2 Point Delivery) ENT-2026-005491-3260103667 / ENT-2026-005492-3260111054',
    });
    ok(/\u{1F3AF} \*To\* - Degam 396530\n\u{1F4CD} \*Also drop\* - Hathras 204101\n/u.test(m), `structured drop renders as its own labelled line (got: ${JSON.stringify(m)})`);
    ok(!/mentions 2 point/.test(m), 'structured data present -> the free-text fallback never fires alongside it');
    ok(!/ENT-2026-005491/.test(m.split('Also')[1] && m.split('Also')[1].split('\n')[0]), 'the Also line never carries the shipper reference text');
  }

  // ---- GC-2: structured extra PICKUP, its own labelled line ---------------------------------
  {
    const m = renderMessage('price_needed', {
      ...BASE,
      otherOrigins: [{ city: 'Valsad', pincode: '396001' }],
    });
    ok(/\u{1F4CD} \*Also pickup\* - Valsad 396001/u.test(m), `structured pickup renders as its own labelled line (got: ${JSON.stringify(m)})`);
  }

  // ---- GC-2: both an extra pickup and an extra drop -> two separate lines, never joined on one ---
  {
    const m = renderMessage('price_needed', {
      ...BASE,
      otherOrigins: [{ city: 'Sampleville', pincode: '444444' }],
      otherDestinations: [{ city: 'Otherplace', pincode: '555555' }],
    });
    ok(/\u{1F4CD} \*Also pickup\* - Sampleville 444444/u.test(m), `the extra pickup gets its own line (got: ${JSON.stringify(m)})`);
    ok(/\u{1F4CD} \*Also drop\* - Otherplace 555555/u.test(m), `the extra drop gets its own line (got: ${JSON.stringify(m)})`);
    ok(!/Sampleville 444444, Otherplace 555555/.test(m), 'a pickup and a drop must never be joined onto the same line - that reads a drop as a pickup');
  }

  // ---- GC-3: a stop list past a WhatsApp-safe length is capped, never spelled out in full --------
  {
    const many = Array.from({ length: 2000 }, (_, i) => ({ city: `Town${i}`, pincode: String(200000 + i) }));
    const m = renderMessage('price_needed', { ...BASE, otherDestinations: many });
    ok(m.length < 1000, `a 2,000-stop list must not blow the message past WhatsApp's ~4,700-char limit (got length ${m.length})`);
    ok(/\u{1F4CD} \*Also drop\* - Town0 200000, Town1 200001, Town2 200002, \+1997 more/u.test(m), `shows the first 3 then a count (got: ${JSON.stringify(m)})`);
  }

  // ---- free-text fallback, only when structured fields are absent/empty -------------------------
  {
    const m1 = renderMessage('price_needed', {
      ...BASE, shipperRef: '(2 Point Unloading) ENT-2026-005133',
    });
    ok(/\u{1F4CD} \*Also\* - mentions 2 point/u.test(m1), `free text alone -> "mentions 2 point" (got: ${JSON.stringify(m1)})`);

    const m2 = renderMessage('price_needed', {
      ...BASE, otherDestinations: [], shipperRef: '(2 Point Delivery) ENT-2026-005491',
    });
    ok(/mentions 2 point/.test(m2), 'an empty structured array still falls back to the free-text signal');
  }

  // ---- GC-6: a whole point-count, never a "2" substring inside a bigger number ------------------
  {
    const m3 = renderMessage('price_needed', {
      ...BASE, shipperRef: '(3 Point Unloading) ENT-2026-005999',
    });
    ok(/mentions 3 point/.test(m3), `"3 Point" free text -> "mentions 3 point" (got: ${JSON.stringify(m3)})`);

    const m12 = renderMessage('price_needed', {
      ...BASE, shipperRef: '(12 Point Delivery) ENT-2026-006000',
    });
    ok(!/mentions 2 point/.test(m12), `"12 Point" must never be misread as "2 point" (got: ${JSON.stringify(m12)})`);
    ok(/mentions 12 point/.test(m12), `"12 Point" free text -> "mentions 12 point" (got: ${JSON.stringify(m12)})`);
  }

  // ---- genuinely single-point -> no "Also" line, message unchanged ------------------------------
  {
    const m = renderMessage('price_needed', { ...BASE, shipperRef: '3260108709' });
    ok(!/Also/.test(m), `a single-point load with an ordinary OA reference carries no extra-stop line (got: ${JSON.stringify(m)})`);
    const withOa = renderMessage('price_needed', { ...BASE, shipperRef: '' });
    const noSignal = renderMessage('price_needed', BASE);
    ok(withOa === noSignal, 'single-point renders byte-identically whether shipperRef/otherOrigins/otherDestinations are present or wholly absent');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
