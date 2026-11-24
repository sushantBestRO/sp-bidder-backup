'use strict';
/**
 * THE LANE-END NORMALIZER IS IDEMPOTENT, AND ITS CITY COLUMN NEVER KEEPS A STATE.
 *
 * Regression target: A017. canonicalPlace stripped one trailing state and title-cased, so
 * 'Mumbai, Maharashtra, MH' came out as 'Mumbai, Maharashtra' (a state left in the city column) and
 * only reached 'Mumbai' on a second pass; and an address it declined and bounded on pass one
 * ('Plot 12, MIDC, Taloja...') was short enough on pass two to be read as a place and recased.
 * Applying it to its own output must change nothing.
 *
 * Covers fixed cases plus a seeded generated set (city x state-suffix chains, and long addresses).
 *
 *   node scripts/test-canonical-place-idempotent.js
 */
const { canonicalPlace, INDIAN_STATE_CODES } = require('../src/web/laneDisplay');
const { INDIAN_STATES } = require('../src/platform/gocometLane');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

const fixed = [
  ['Mumbai, Maharashtra, MH', 'Mumbai'],
  ['ahmedabad, GJ, gujarat', 'Ahmedabad'],
  ['Bawal, HR', 'Bawal'],
  ['UDHAMPUR', 'Udhampur'],
  ['Sikandrabad', 'Sikandrabad'],
  ['McLeodganj', 'McLeodganj'],
];
for (const [raw, want] of fixed) {
  const got = canonicalPlace(raw);
  ok(got === want, `${JSON.stringify(raw)} -> ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
}

const declined = 'Plot 12, MIDC, Taloja Industrial Area, Navi Mumbai 410208';
{
  const once = canonicalPlace(declined);
  const twice = canonicalPlace(once);
  ok(twice === once, `a bounded address is not recased on a second pass (${JSON.stringify(once)} -> ${JSON.stringify(twice)})`);
}

let seed = 20260926;
const rnd = (n) => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (((t ^ (t >>> 14)) >>> 0) % n);
};
const cities = ['mumbai', 'PUNE', 'Sikandrabad', 'navi mumbai', 'McLeodganj', 'Bawal', 'hosur', 'Goa', 'Delhi'];
const states = INDIAN_STATE_CODES.concat(INDIAN_STATES);
const caseOf = (s) => [s, s.toUpperCase(), s.toLowerCase()][rnd(3)];
let notIdempotent = 0, stateLeft = 0, firstBad = null;
const N = 4000;
for (let i = 0; i < N; i++) {
  let raw;
  if (rnd(5) === 0) {
    raw = `Plot ${rnd(900)}, ${caseOf('MIDC')}, ${caseOf('Taloja Industrial Area')}, ${caseOf(cities[rnd(cities.length)])} ${400000 + rnd(99999)}`;
  } else {
    raw = caseOf(cities[rnd(cities.length)]);
    const k = rnd(4);
    for (let j = 0; j < k; j++) raw += `, ${caseOf(states[rnd(states.length)])}`;
  }
  const once = canonicalPlace(raw);
  const twice = canonicalPlace(once);
  if (twice !== once) { notIdempotent++; if (!firstBad) firstBad = `${JSON.stringify(raw)} -> ${JSON.stringify(once)} -> ${JSON.stringify(twice)}`; }
  const tail = once.includes(',') ? once.slice(once.lastIndexOf(',') + 1).trim().toLowerCase() : null;
  if (tail && states.some((s) => s.toLowerCase() === tail)) {
    stateLeft++; if (!firstBad) firstBad = `${JSON.stringify(raw)} -> ${JSON.stringify(once)} (state left)`;
  }
}
ok(notIdempotent === 0, `generated: f(f(x)) === f(x) on all ${N} cases (${notIdempotent} differ${firstBad ? `; first: ${firstBad}` : ''})`);
ok(stateLeft === 0, `generated: no output ends in a state (${stateLeft} do)`);

const total = pass + fail;
if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
console.log(`\n${pass}/${total} checks passed`);
