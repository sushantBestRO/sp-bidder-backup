'use strict';
/**
 * Pins C102 (fix/ops-alerting-divergences).
 *
 * projectEnquiryDetail (the allowlist projection over GoComet's enquiry-detail response) dropped
 * any field not in ENQUIRY_DETAIL_FIELDS silently - a field GoComet adds is exactly the drift a
 * hand-maintained allowlist cannot otherwise catch. It now logs once per unrecognised field name
 * for the life of the process, and the known/allowlisted shape is unaffected either way.
 *
 * @requires-summary-line
 *   node scripts/test-c102-unrecognized-enquiry-field-logged-once.js
 */
const assert = require('assert');
const { projectEnquiryDetail } = require('../src/platform/gocometAdapter');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

function withCapturedLogs(fn) {
  const origError = console.error, origLog = console.log;
  const lines = [];
  console.error = (l) => lines.push(l);
  console.log = (l) => lines.push(l);
  try { fn(); } finally { console.error = origError; console.log = origLog; }
  return lines;
}

(async () => {
  // ---- an unrecognised field logs at warn, naming the field ----
  {
    const raw = { cargo_quantity: '10', cargo_unit: 'MT', slab_rate: '100', a_brand_new_field_gocomet_added: 'surprise' };
    let out;
    const lines = withCapturedLogs(() => { out = projectEnquiryDetail(raw); });
    assert.strictEqual(out.a_brand_new_field_gocomet_added, undefined, 'the projection still drops the unrecognised field from its output (allowlist behavior unchanged)');
    assert.strictEqual(out.cargo_quantity, '10', 'known fields still pass through');
    const match = lines.find((l) => typeof l === 'string' && l.includes('a_brand_new_field_gocomet_added'));
    assert.ok(match, `C102: the unrecognised field is logged: lines seen = ${JSON.stringify(lines)}`);
    const parsed = JSON.parse(match);
    assert.strictEqual(parsed.level, 'warn', `C102: logged at warn level, got "${parsed.level}"`);
    ok('C102: an unrecognised field is logged at warn, naming the field, and still dropped from the output');
  }

  // ---- the SAME field on a later call does not re-log (once per field, not once per call) ----
  {
    const raw = { cargo_quantity: '20', a_brand_new_field_gocomet_added: 'still here' };
    const lines = withCapturedLogs(() => { projectEnquiryDetail(raw); });
    const match = lines.find((l) => typeof l === 'string' && l.includes('a_brand_new_field_gocomet_added'));
    assert.ok(!match, `C102: the same unrecognised field name does not re-log on a later call: lines seen = ${JSON.stringify(lines)}`);
    ok('C102: an already-seen unrecognised field does not repeat the log line');
  }

  // ---- a NEW, different unrecognised field still logs (the dedupe is per-name, not global) ----
  {
    const raw = { cargo_quantity: '30', a_second_new_field: 'x' };
    const lines = withCapturedLogs(() => { projectEnquiryDetail(raw); });
    const match = lines.find((l) => typeof l === 'string' && l.includes('a_second_new_field'));
    assert.ok(match, `C102: a DIFFERENT unrecognised field name still logs: lines seen = ${JSON.stringify(lines)}`);
    ok('C102: the once-per-field dedupe is keyed on field name, not a blanket silence');
  }

  // ---- control: a response with only known fields never logs anything ----
  {
    const raw = { cargo_quantity: '40', cargo_unit: 'MT', slab_rate: '50' };
    const lines = withCapturedLogs(() => { projectEnquiryDetail(raw); });
    assert.strictEqual(lines.length, 0, `control: an all-known-fields response logs nothing: got ${JSON.stringify(lines)}`);
    ok('control: a response carrying only allowlisted fields never logs');
  }

  console.log(`\n${pass}/4 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
