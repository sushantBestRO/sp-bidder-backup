'use strict';
/**
 * Owner-preserve regression (PR #83 review, finding F1): validateAssignment REBUILDS the record on
 * every write (upsert() is the only write path), and the original `owner: input.owner === true`
 * defaulted an OMITTED field to false. Every writer that does not resend `owner: true` - the
 * console (whose TS Assignment type had no `owner` member), migrate.js's legacy re-derivation, and
 * POST /api/assignments's raw `req.body` passthrough - silently erased an existing desk-owner
 * designation on any unrelated edit, with no error and no log line.
 *
 * Fixed with preserve-unless-explicitly-set semantics: an omitted/non-boolean `owner` on the input
 * carries forward the STORED record's existing value (false for a brand-new record); only an input
 * that explicitly sends a boolean - true or false - writes through. This file proves the fix at
 * each writer the review cited, plus the explicit-clear case the fix must not break.
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const assert = require('assert');
const http = require('http');
const { createStore } = require('../src/store');
const { CustomerStore } = require('../src/model/customerStore');
const { PersonStore } = require('../src/model/personStore');
const { AssignmentStore } = require('../src/model/assignmentStore');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log('  ok  ' + m); };

function req(method, url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(url);
    const headers = Object.assign(
      data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
      extraHeaders || {},
    );
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, json }); }); },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  console.log('\n=== 1. (a) an unrelated store-level edit preserves an existing owner:true ===');
  {
    const store = createStore({ backend: 'memory' });
    const customers = new CustomerStore({ store });
    const people = new PersonStore({ store });
    const assignments = new AssignmentStore({ store, people, customers });
    const cust = await customers.upsert({ label: 'Havells' });
    const per = await people.upsert({ name: 'Sameer', phone: '9594963428' });

    const designated = await assignments.upsert({ personId: per.personId, customerId: cust.customerId, owner: true });
    ok(designated.owner === true, 'designation writes owner:true');

    // The console today saves exactly this shape - personId/customerId plus whatever field the
    // operator actually touched - because saveAssignment's TS type had no `owner` member to send.
    const editedAlerts = await assignments.upsert({ personId: per.personId, customerId: cust.customerId, alertKinds: ['won', 'lost'] });
    ok(editedAlerts.owner === true, 'editing alertKinds (owner omitted) preserves owner:true');

    const editedEnabled = await assignments.upsert({ personId: per.personId, customerId: cust.customerId, enabled: false });
    ok(editedEnabled.owner === true, 'toggling enabled (owner omitted) preserves owner:true');

    const editedMargin = await assignments.upsert({ personId: per.personId, customerId: cust.customerId, marginOverride: { marginsPct: [9, 7, 5], minMarginPct: 5 } });
    ok(editedMargin.owner === true, 'setting a marginOverride (owner omitted) preserves owner:true');

    ok((await assignments.get(designated.assignmentId)).owner === true, 'the persisted doc itself carries owner:true, not just the return value');
  }

  console.log("\n=== 2. (b) migrate.js:67's exact upsert() call shape does not clear a pre-existing owner:true ===");
  {
    // migrate.js:67 calls `assignments.upsert({ personId, customerId, enabled: true })` - no owner
    // key at all. The live guard (migrateLegacyModel only runs while customers/people/assignments
    // are ALL empty) means this exact scenario cannot reach a pre-populated store today, but the
    // fix belongs in the shared upsert() the whole model writes through, not a migrate-only patch -
    // so reproduce the call shape directly against a store that already has a designated owner.
    const store = createStore({ backend: 'memory' });
    const customers = new CustomerStore({ store });
    const people = new PersonStore({ store });
    const assignments = new AssignmentStore({ store, people, customers });
    const cust = await customers.upsert({ label: 'KEI Industries' });
    const per = await people.upsert({ name: 'Priya', phone: '9820011223' });
    await assignments.upsert({ personId: per.personId, customerId: cust.customerId, owner: true });

    const migrated = await assignments.upsert({ personId: per.personId, customerId: cust.customerId, enabled: true });
    ok(migrated.owner === true, "migrate.js's exact upsert shape ({personId, customerId, enabled: true}) preserves owner:true");
  }

  console.log('\n=== 3. (c)+(d) POST /api/assignments - the console + designation-script save path ===');
  {
    const { app } = require('../src/web/server');
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (p) => req('GET', base + p);
    const post = (p, b) => req('POST', base + p, b, { origin: base });

    const cust = await post('/api/customers', { label: 'Syngenta' });
    ok(cust.status === 200, 'seed customer created');
    const per = await post('/api/people', { name: 'Rohit', phone: '9594900001' });
    ok(per.status === 200, 'seed person created');
    const { customerId } = cust.json.customer;
    const { personId } = per.json.person;

    // designate - the field a future console UI (or the designation script, over HTTP) would send;
    // the dashboard Assignment TS type + saveAssignment passthrough now carry it through.
    const designated = await post('/api/assignments', { personId, customerId, owner: true });
    ok(designated.status === 200 && designated.json.assignment.owner === true, 'POST /api/assignments can designate owner:true');

    // the exact shape saveAssignment sends today - personId/customerId + the touched field, no
    // owner key at all, because the dashboard type didn't have one until this fix.
    const consoleEdit = await post('/api/assignments', { personId, customerId, alertKinds: ['won'] });
    ok(consoleEdit.status === 200, 'console-shaped save succeeds');
    ok(consoleEdit.json.assignment.owner === true, '(c) the console save path (owner omitted) preserves owner:true');

    const stillTrue = await get('/api/assignments');
    ok(stillTrue.json.assignments.find((a) => a.assignmentId === designated.json.assignment.assignmentId).owner === true,
      'owner:true also holds on a fresh read, not just the POST response');

    // (d) explicit owner:false must still clear it - the fail-safe direction is not a one-way latch
    const cleared = await post('/api/assignments', { personId, customerId, owner: false });
    ok(cleared.status === 200 && cleared.json.assignment.owner === false, '(d) an explicit owner:false input still clears the flag');

    server.close();
  }

  console.log(`\n${pass} passed, 0 failed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
