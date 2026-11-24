'use strict';
/**
 * A BLANK SP_MIN_MARGIN_PCT MEANS THE HOUSE DEFAULT, NOT A 0% OPERATING FLOOR.
 *
 * Regression target: D072. config.minMarginPct read `SP_MIN_MARGIN_PCT != null ? Number(v) : 6.3`,
 * and Number('') is 0, so a cleared env var set the operating floor to exactly cost. Every other
 * money-path knob already goes through the blank-aware numKnobOr. An explicit '0' is still an
 * explicit 0 (the downstream zero-floor gates own that case); a blank or junk value is the default.
 *
 *   node scripts/test-min-margin-knob-blank-aware.js
 */
const { spawnSync } = require('child_process');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

const configPath = path.join(__dirname, '..', 'src', 'config.js');
function knobFor(value) {
  const env = Object.assign({}, process.env);
  if (value === undefined) delete env.SP_MIN_MARGIN_PCT; else env.SP_MIN_MARGIN_PCT = value;
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(configPath)}).minMarginPct))`],
    { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`config load failed for ${JSON.stringify(value)}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const cases = [
  ['', 6.3, 'an empty value is the house default'],
  ['   ', 6.3, 'a whitespace-only value is the house default'],
  ['abc', 6.3, 'a non-numeric value is the house default, never NaN'],
  [undefined, 6.3, 'an unset value is the house default'],
  ['4.5', 4.5, 'a real value is taken as typed'],
  ['0', 0, 'an explicit 0 stays an explicit 0 for the zero-floor gates to refuse'],
];
for (const [value, want, label] of cases) {
  const got = knobFor(value);
  ok(got === want, `${label} (SP_MIN_MARGIN_PCT=${JSON.stringify(value)} -> ${JSON.stringify(got)}, want ${want})`);
}

const total = pass + fail;
if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
console.log(`\n${pass}/${total} checks passed`);
