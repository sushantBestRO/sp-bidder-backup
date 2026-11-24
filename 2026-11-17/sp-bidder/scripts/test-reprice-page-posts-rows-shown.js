'use strict';
/**
 * The /price re-price submit posts the rows the page showed, and keeps them current across AJAX saves.
 *
 * The re-price compares the posted rows with rows_shown (the band the page rendered), so a band the
 * console re-snapshotted under an open page is not mistaken for the desk's edit (B-1, fix e80a591).
 * The re-price handler builds its JSON body by hand, and it never added rows_shown, so on the real page
 * the server always fell back to the stored band: the fix was inert. After a save the page stays open
 * and redraws the rows from the response, so rows_shown must follow them or the next save on the same
 * page compares against the first render.
 *
 * There is no DOM harness, so this reads the served script out of server.js, as the other page-script
 * pins do.
 *
 *   node scripts/test-reprice-page-posts-rows-shown.js
 */
const fs = require('fs'); // allowed: reads server.js as text
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
let pass = 0;
const ok = (n, m) => { console.log(`  ok  ${n}. ${m}`); pass++; };

const start = src.indexOf('var body={cost:cost.value};');
const end = src.indexOf('submitJson(body,btn,false);', start);
assert.ok(start > 0 && end > start, 'setup: the re-price body assembly was not found in the served script');
const assembly = src.slice(start, end);
assert.ok(/body\.rows_shown\s*=/.test(assembly), 'the re-price submit never posts rows_shown, so the server compares against the stored band');
ok(1, 'the re-price submit posts rows_shown');

const a0 = src.indexOf('function applyUpdated(updated){');
const a1 = src.indexOf('\n}\n', a0);
assert.ok(a0 > 0 && a1 > a0, 'setup: applyUpdated was not found in the served script');
const apply = src.slice(a0, a1);
assert.ok(/rows_shown/.test(apply) && /marginsPct/.test(apply),
  'after an AJAX save the page redraws its rows but leaves rows_shown at the first render');
ok(2, 'an AJAX save refreshes rows_shown to the rows it redrew');

console.log(`\n${pass}/2 checks passed`);
