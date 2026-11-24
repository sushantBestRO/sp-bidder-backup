'use strict';
/**
 * LIVE BIDS MATCHES EACH LIVE ROW TO ITS PRICE REQUEST BY (PORTAL, ID), NOT BY ID ALONE.
 *
 * Regression target: C063 review finding 9. LiveBids.tsx built its request lookup as
 * Map(loadId -> request) and read it with the row's auctionId, so with one id on both portals a
 * GoComet row showed, scoped and labelled itself off whichever SuperProcure request won the map.
 *
 * A STATIC check on the shipped source, deliberately: the console has no test runner and this suite
 * must run in a clean clone without the dashboard's dependencies installed. It pins the join key -
 * every lookup of a request for a live row goes through one key that carries the portal - rather
 * than rendering the page. The type-check (`cd dashboard && npx tsc --noEmit`) covers that it compiles.
 *
 *   node scripts/test-livebids-joins-by-portal.js
 */
const fs = require('fs'); // allowed: reads a source file, not app state
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'src', 'pages', 'LiveBids.tsx'), 'utf8');

const bareBuild = /\.map\(\s*\(r\)\s*=>\s*\[\s*r\.loadId\s*,\s*r\s*\]/.test(src);
ok(!bareBuild, 'the request map is not keyed on loadId alone');
const bareGets = src.match(/reqByLoad\.get\(\s*a\.auctionId\s*\)/g) || [];
ok(bareGets.length === 0, `no live row looks its request up by auctionId alone (${bareGets.length} site(s))`);
ok(/platformKey/.test((src.match(/const reqKey[^\n]*/) || [''])[0]),
  'one join key for request lookups, and it carries the portal');

const total = pass + fail;
if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
console.log(`\n${pass}/${total} checks passed`);
