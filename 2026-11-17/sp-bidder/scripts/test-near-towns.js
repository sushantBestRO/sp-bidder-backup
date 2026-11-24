'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = path.join(os.tmpdir(), 'fr8-near-test-' + process.pid + '.json');
const now = Date.now();
const row = (key, rate) => ({ key, label: key, payload: null, approx: false, rate, low: rate - 1000, high: rate + 1000 });
fs.writeFileSync(tmp, JSON.stringify({ version: 1, routes: {
  'nagpur>pune': { fetchedAt: now, rows: [row('sxl32', 24000), row('mxl32', 35100)] },
  'pune>nagpur': { fetchedAt: now, rows: [row('sxl32', 23000)] },
} }));
process.env.FR8_RATES_FILE = tmp;
const rh = require('../src/notify/rateHints');
let ok = 0, bad = 0;
const check = (name, cond) => { if (cond) ok++; else { bad++; console.log('FAIL:', name); } };
const ld = (o, d, eq) => ({ lane: { origin: o, destination: d }, equipment: eq });
const SXL = 'Container 32FT SXL (32*8*9) . 7 MT';

check('hubSlug stays strict (Chakan = null)', rh.hubSlug('Chakan 410501') === null);
check('hubSlugNear Chakan = pune', rh.hubSlugNear('Chakan 410501') === 'pune');
check('hubSlugNear unknown town = null', rh.hubSlugNear('Malur 563130') === null);
let h = rh.fr8Hint(ld('Nagpur 441501', 'Chakan 410501', SXL), {});
check('Nagpur>Chakan gives pune rate', h && h.rate === 24000);
check('bracket text', h && JSON.stringify(h.via) === JSON.stringify(['Chakan → Pune']));
h = rh.fr8Hint(ld('Nagpur', 'Pune', SXL), {});
check('direct hub has empty via', h && h.rate === 24000 && Array.isArray(h.via) && h.via.length === 0);
h = rh.fr8Hint(ld('Butibori', 'Chakan', SXL), {});
check('town on both ends', h && h.rate === 24000 && h.via.length === 2);
check('Pune>Chakan (same hub) = no line', rh.fr8Hint(ld('Pune', 'Chakan', SXL), {}) === null);
check('town lane, no saved route = null', rh.fr8Hint(ld('Nagpur', 'Sanand', SXL), {}) === null);
check('unsupported vehicle still null', rh.fr8Hint(ld('Nagpur', 'Chakan', 'Trailer 40\''), {}) === null);
check('per-tonne load still null', rh.fr8Hint(ld('Nagpur', 'Chakan', SXL), { pmtBasis: true }) === null);
const hubs = new Set(Object.values(rh.HUB_SLUG));
const badVals = Object.entries(rh.NEAR_TOWN).filter(([, v]) => !hubs.has(v));
check('every town points at a real hub ' + JSON.stringify(badVals), badVals.length === 0);
const clash = Object.keys(rh.NEAR_TOWN).filter((k) => Object.prototype.hasOwnProperty.call(rh.HUB_SLUG, k));
check('no town is also a hub ' + JSON.stringify(clash), clash.length === 0);
const bad2 = Object.keys(rh.NEAR_TOWN).filter((k) => rh.normPlace(k) !== k);
check('keys are normalised ' + JSON.stringify(bad2), bad2.length === 0);
fs.unlinkSync(tmp);
console.log(ok + '/' + (ok + bad) + ' checks passed');
process.exit(bad ? 1 : 0);
