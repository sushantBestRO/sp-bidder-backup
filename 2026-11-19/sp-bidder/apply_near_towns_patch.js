'use strict';
// Adds "nearby town -> FR8 hub" matching to the FR8 guide line. Run from the project root.
const fs = require('fs'); const path = require('path'); const cp = require('child_process');
const root = process.cwd();
const F = { rh: 'src/notify/rateHints.js', wa: 'src/notify/waTemplates.js', sc: 'scripts/fr8-rates.js', nt: 'src/notify/nearTowns.js' };
for (const k of Object.keys(F)) {
  if (!fs.existsSync(path.join(root, F[k]))) { console.error('Missing ' + F[k] + ' - unzip into the project root first. Nothing changed.'); process.exit(1); }
}
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let rh = read(F.rh); let wa = read(F.wa); let sc = read(F.sc);
if (rh.includes('hubMatch')) { console.log('Already applied. Nothing changed.'); process.exit(0); }
function once(src, find, repl, label) {
  const i = src.indexOf(find);
  if (i < 0 || src.indexOf(find, i + 1) >= 0) { console.error('Cannot patch (' + label + '): expected text not found exactly once. Nothing was changed.'); process.exit(1); }
  return src.slice(0, i) + repl + src.slice(i + find.length);
}
const BLOCK = [
  "// Nearby towns that FR8 prices as a hub (src/notify/nearTowns.js). FR8 guide only; shown in brackets.",
  "const NEAR_TOWN = require('./nearTowns');",
  "const titleCase = (s) => String(s).replace(/\\b[a-z]/g, (c) => c.toUpperCase());",
  "function hubMatch(place) {",
  "  const n = normPlace(place);",
  "  if (Object.prototype.hasOwnProperty.call(HUB_SLUG, n)) return { slug: HUB_SLUG[n], via: null };",
  "  if (Object.prototype.hasOwnProperty.call(NEAR_TOWN, n)) return { slug: NEAR_TOWN[n], via: titleCase(n) };",
  "  return null;",
  "}",
  "function hubSlugNear(place) { const m = hubMatch(place); return m ? m.slug : null; }",
  "",
  "",
].join('\n');
const OLD = "    const from = hubSlug(L.lane.origin);\n    const to = hubSlug(L.lane.destination);\n    if (!from || !to || from === to) return null;\n";
const NEW = [
  "    const fm = hubMatch(L.lane.origin);",
  "    const tm = hubMatch(L.lane.destination);",
  "    if (!fm || !tm) return null;",
  "    const from = fm.slug;",
  "    const to = tm.slug;",
  "    if (!from || !to || from === to) return null;",
  "    const via = [fm, tm].filter((m) => m.via).map((m) => m.via + ' \u2192 ' + titleCase(m.slug));",
  "",
].join('\n');
rh = once(rh, 'const routeKey = (fromSlug, toSlug) =>', BLOCK + 'const routeKey = (fromSlug, toSlug) =>', 'rateHints: insert');
rh = once(rh, OLD, NEW, 'rateHints: fr8Hint lane');
rh = once(rh, 'approx: !!row.approx, asOf: at };', 'approx: !!row.approx, asOf: at, via };', 'rateHints: return');
rh = once(rh, '  HUB_SLUG, loadRates, ratesFile, flag,\n};', '  HUB_SLUG, loadRates, ratesFile, flag, hubMatch, hubSlugNear, NEAR_TOWN,\n};', 'rateHints: exports');
wa = once(wa, '*FR8 guide* - ${f.approx',
  "*FR8 guide*${Array.isArray(f.via) && f.via.length ? ' (' + f.via.join(', ') + ')' : ''} - ${f.approx", 'waTemplates');
sc = once(sc, 'hubSlug(r.lane.origin)', 'hubSlugNear(r.lane.origin)', 'fr8-rates origin');
sc = once(sc, 'hubSlug(r.lane.destination)', 'hubSlugNear(r.lane.destination)', 'fr8-rates destination');
sc = once(sc, 'hubSlug, fr8ClassOf', 'hubSlug, hubSlugNear, fr8ClassOf', 'fr8-rates import');

const stamp = 'near-' + Date.now();
const out = { rh, wa, sc }; const names = { rh: F.rh, wa: F.wa, sc: F.sc };
for (const k of Object.keys(out)) fs.copyFileSync(path.join(root, names[k]), path.join(root, names[k] + '.bak-' + stamp));
for (const k of Object.keys(out)) fs.writeFileSync(path.join(root, names[k]), out[k]);
try {
  for (const k of Object.keys(out)) cp.execFileSync(process.execPath, ['--check', path.join(root, names[k])], { stdio: 'pipe' });
  console.log('Patched. Backups end with .bak-' + stamp);
} catch (e) {
  for (const k of Object.keys(out)) fs.copyFileSync(path.join(root, names[k] + '.bak-' + stamp), path.join(root, names[k]));
  console.error('Syntax check failed - everything restored from backup.\n' + (e.stderr || e.message));
  process.exit(1);
}
