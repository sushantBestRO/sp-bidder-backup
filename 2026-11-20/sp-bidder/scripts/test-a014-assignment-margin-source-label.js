'use strict';
/**
 * A014: resolve.js's resolveMargin can emit an "assignment:<id>" margin-source prefix (an
 * assignment-level override), but the /price page's source pill and the console's margin-override
 * note each recognised only 'bid' and a 'customer:' prefix - an assignment-overridden load was
 * misreported as "default margins" on the price page, and shown with NO margin tag at all in the
 * console table.
 *
 * Regression target: A014. server.js:5449's srcLabel and
 * dashboard/src/pages/PriceRequests.tsx:344's marginSource === 'bid' check, at the time this was
 * written.
 *
 * @requires-summary-line
 *   node scripts/test-a014-assignment-margin-source-label.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'a014-'));

const http = require('http');
const assert = require('assert');
const { app, requests } = require('../src/web/server');
const { COLLECTION } = require('../src/pricing/priceRequests');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass += 1; }

function get(base, p) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const now = Date.now();
  const load = {
    id: 'A014-1', lane: { origin: 'Alwar', destination: 'Pune' }, equipment: '32ft', units: 1,
    companyName: 'Havells India', closesAt: now + 3600000, startsAt: now - 60000,
  };
  const r = await requests.createForLoad(load, { deadlineAt: now + 60000 });
  await requests.store.patchDoc(COLLECTION, r.id, { marginSource: 'assignment:g1::havells' });

  const price = await get(base, `/price/${r.id}`);
  ok(price.status === 200, `fixture renders (status ${price.status})`);
  ok(price.body.includes('this assignment’s margins'),
    `an assignment-overridden load must be labelled by its actual source, not fall through to "default margins" (page did${price.body.includes('default margins') ? '' : ' not'} include "default margins")`);
  ok(!price.body.includes('>default margins<') && !/pill">default margins/.test(price.body),
    'an assignment override must never render as "default margins"');

  console.log(`${pass}/${pass} checks passed`);
  server.close();
})().catch((e) => {
  console.error('FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
