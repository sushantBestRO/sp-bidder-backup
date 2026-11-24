'use strict';
/**
 * THE DESK PRICE AUDIT TRAIL SURVIVES THE ACT OF PRICING (CW-211).
 *
 * On 2026-09-08 load 260908LD2Z was captured at Rs 29,000, re-priced to Rs 38,000 two minutes
 * later, and closed rank 1 at Rs 31,610. Reconstructing which of those two numbers the desk meant
 * needed a forensic audit, because the trail recorded neither of them usefully:
 *
 *   - the capture wrote NO configChanges row at all. The audit call was gated on
 *     `marginSource === 'bid'` - true only when a bid-level margin override rode along with the
 *     cost - so a cost typed onto an inherited customer band built a live ladder unaudited. That
 *     is why Rs 29,000 is absent from that day's trail while the Rs 38,000 correction is present.
 *   - every row ever written carried the literal `before: null`, which was read during the audit
 *     as "there was no prior value" and had to be retracted. It is not that; it is no information.
 *   - the re-price rows all read `actor: "unknown"`, because the /price link is public by design
 *     and carries no admin session.
 *
 * A REAL BOOTED APP, driven over HTTP through the public /price link, for the same reason
 * test-relink-qr-audit-ip.js boots one: the defect lives in what the ROUTE resolves (req.admin
 * absent, reqDoc read before the write), and a hand-built req object would assert that the audit
 * helper copies fields it was handed - which was never in doubt.
 *
 *   node scripts/test-price-audit-trail.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-price-audit-'));

const http = require('http');
const { app, requests, store } = require('../src/web/server');

// Every assertion below must run. Without this, a `return` added above the tail would exit 0 and
// the runner - which grades on exit status alone - would score a zero-assertion file GREEN.
const EXPECTED_CHECKS = 16;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

function req(method, url, { body = null, contentType = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType || 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const jsonBody = (obj) => JSON.stringify(obj);
const rowsFor = async (loadId) => (await store.readEvents('configChanges'))
  .filter((e) => Array.isArray(e.changed) && e.changed.some((c) => String(c).includes(loadId)));

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now();
  const mkLoad = (id) => ({
    id, lane: { origin: 'Degam', destination: 'Vadodara' }, equipment: '40ft Trailer', units: 1,
    companyName: 'Waaree', closesAt: now + 20 * 60_000, startsAt: now - 60_000,
    softClose: false, closeModelKnown: true, status: 'live',
  });

  // ---- a PLAIN cost capture on an inherited band is audited ----
  // The exact shape that wrote nothing: one cost, no use_override, so marginSource stays inherited.
  const r = await requests.createForLoad(mkLoad('LD2Z'));
  const cap = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '29000' }) });
  ok(cap.status === 200, 'capture: a plain Rs 29,000 on the inherited band arms the load');
  const armedDoc = await requests.getByToken(r.id);
  ok(armedDoc.marginSource !== 'bid', 'capture: the band really is inherited, not a bid-level override');

  const afterCapture = await rowsFor('LD2Z');
  ok(afterCapture.length === 1, 'capture: the cost capture wrote exactly one audit row');
  const capRow = afterCapture[0];
  ok(capRow && capRow.action === 'cost_captured', 'capture: the row names the action as a cost capture');
  ok(capRow && capRow.changes[0].after.cost === 29000, 'capture: the row carries the cost that was entered');
  ok(capRow && capRow.changes[0].beforeKnown === true, 'capture: the row states that the prior value WAS resolved');
  ok(capRow && capRow.changes[0].before && capRow.changes[0].before.cost === null,
    'capture: and that there genuinely was no prior cost - not the same claim as the old hardcoded null');
  ok(capRow && capRow.actor === 'pricing' && capRow.via === 'price-link',
    'capture: the actor is the desk link seam, not "unknown"');
  ok(capRow && capRow.origin === 'pricing', 'capture: the origin tag the call site passes actually lands on the row');
  ok(capRow && typeof capRow.ts === 'number', 'capture: the row is timestamped');

  // ---- the re-price records what the cost WAS, not just what it became ----
  const band = { m_0: '12.6', m_1: '7.2', m_2: '6.3' };
  const rep = await req('POST', `${base}/price/${r.id}`, { body: jsonBody({ cost: '38000', ...band }), contentType: 'application/json' });
  ok(rep.status === 200, 're-price: the desk correction to Rs 38,000 is accepted');

  const afterReprice = await rowsFor('LD2Z');
  const repRow = afterReprice.find((e) => e.action === 'margin_override_set');
  ok(!!repRow, 're-price: the correction wrote its own audit row');
  ok(repRow && repRow.changes[0].before && repRow.changes[0].before.cost === 29000,
    're-price: the row holds the cost the standing ladder was built from');
  ok(repRow && repRow.changes[0].after.cost === 38000, 're-price: and the cost that replaced it');
  ok(repRow && repRow.actor === 'pricing' && repRow.via === 'price-link',
    're-price: the desk re-price is attributed to the link seam, not "unknown"');

  // ---- THE QUESTION THE 2026-09-08 AUDIT COULD NOT ANSWER ----
  // Both costs, in order, from the trail alone - no dividing a bid by a ladder multiplier.
  const costTrail = afterReprice
    .filter((e) => e.changes[0] && e.changes[0].after && e.changes[0].after.cost != null)
    .sort((a, b) => a.ts - b.ts)
    .map((e) => e.changes[0].after.cost);
  ok(costTrail.length === 2 && costTrail[0] === 29000 && costTrail[1] === 38000,
    'the trail alone reconstructs the full cost sequence 29,000 -> 38,000');

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (pass + fail !== EXPECTED_CHECKS) {
    console.error(`  FAIL - ran ${pass + fail} checks, expected ${EXPECTED_CHECKS}`);
    process.exit(1);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
