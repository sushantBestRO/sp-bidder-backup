'use strict';
/**
 * Template for a new scripts/test-<slug>.js file. Copy this, rename it, replace the header and
 * the body between the markers.
 *
 * Regression target: <ITEM-ID>, <one-line summary of the behaviour this pins>.
 *
 * @requires-summary-line
 * The marker above opts this file into run-tests.js's stronger gate: it must print its own
 * "N/N checks passed" line, or the runner fails it even on exit 0 - the failure mode this guards
 * against is a test that exits early (an un-ref'd timer, an unhandled early-resolving promise)
 * before its assertions ever ran, which a bare exit-code check cannot catch (D064).
 *
 *   node scripts/test-template.js
 *
 * Excluded from the suite by name (see run-tests.js) - this file is a skeleton to copy, not a
 * test to run.
 */
const assert = require('assert');

let pass = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  pass += 1;
}

(async () => {
  // --- replace with real checks ---
  ok(1 + 1 === 2, 'sanity: arithmetic still works');
  // --- end replace ---

  console.log(`${pass}/${pass} checks passed`);
})().catch((e) => {
  console.error('FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
