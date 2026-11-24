'use strict';
/**
 * Offline test aggregator: runs every scripts/test-*.js and exits non-zero on any
 * failure, so the whole money-path suite is one pre-deploy gate (`npm test`).
 * test-real.js is excluded — it needs a live SuperProcure token. test-template.js is excluded —
 * it is a skeleton to copy, not a real test (see its own header).
 *
 * A file fails on a non-zero exit OR when its own output carries a failure line
 * (FAIL / FAILED / TEST FAILURE at the start of a line), because a file that
 * prints a failure and exits 0 must not count as passed. Mid-line matches are
 * log payloads, not failures.
 *
 * D064: exit-code-only grading has a second hole - a file that exits early (an un-ref'd timer, an
 * unhandled early-resolving promise) before any of its checks ran still exits 0 and prints no
 * failure line, so it is scored as a clean pass having tested nothing. Requiring a completion
 * sentinel from EVERY file would have converted a large fraction of the suite (of 565 test files
 * as of this writing, 139 print no "passed" text anywhere and would need surgery, not just a
 * runner change) - so this is opt-in: a file that carries the `@requires-summary-line` marker
 * near its header must ALSO print its own "N/N checks passed" line, with the two numbers EQUAL
 * ("3/5 checks passed" does not count - it is the same partial-run defect this item exists to
 * catch), or the runner fails it even on exit 0. Every other file is graded exactly as before
 * (byte-safe for the whole existing suite). scripts/test-template.js carries the marker and is the
 * copy-from skeleton for new tests.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FAIL_LINE = /^[ \t]*(?:FAIL(?:ED)?\b|TEST FAILURE\b).*$/m;
const SUMMARY_DECLARED = '@requires-summary-line';
const SUMMARY_LINE = /^(\d+)\/(\d+) checks passed$/gm;

// The two numbers must be EQUAL. "3/5 checks passed" matches the shape but is not a pass - it is
// the same declared-but-incomplete failure this item exists to catch (some checks never ran), and
// a bare shape match would have let it through unnoticed.
function hasCompleteSummary(output) {
  SUMMARY_LINE.lastIndex = 0;
  let m;
  while ((m = SUMMARY_LINE.exec(output || ''))) {
    if (m[1] === m[2]) return true;
  }
  return false;
}

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter((f) => /^test-.*\.js$/.test(f) && f !== 'test-real.js' && f !== 'test-template.js')
  .sort();

let failed = 0;
for (const f of files) {
  process.stdout.write(`\n=== ${f} ===\n`);
  const filePath = path.join(dir, f);
  const requiresSummary = fs.readFileSync(filePath, 'utf8').includes(SUMMARY_DECLARED);
  const r = spawnSync(process.execPath, [filePath], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const failLine = r.status === 0 && (FAIL_LINE.exec(r.stdout || '') || FAIL_LINE.exec(r.stderr || ''));
  if (r.status !== 0 || r.error) {
    failed += 1;
    console.error(`  FAILED: ${f} (exit ${r.status}${r.error ? `, ${r.error.code || r.error.message}` : ''})`);
  } else if (failLine) {
    failed += 1;
    console.error(`  FAILED: ${f} (exit 0, printed a failure line: ${failLine[0].trim()})`);
  } else if (requiresSummary && !hasCompleteSummary(r.stdout) && !hasCompleteSummary(r.stderr)) {
    failed += 1;
    console.error(`  FAILED: ${f} (exit 0, declared ${SUMMARY_DECLARED} but printed no "N/N checks passed" line with N equal to N - a silent early exit or a partial run would otherwise read as green)`);
  }
}
console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed ? 1 : 0);
