'use strict';
/**
 * DELETING A CUSTOMER REMOVES ITS ASSIGNMENTS (S1008).
 *
 * POST /api/customers/:id/delete removed the customer record and left every assignment pointing at
 * it. A group whose only customer was deleted then projected an empty shipper scope, and an empty
 * scope matches every load: the group received every customer's cost, bids and margin.
 *
 * What must happen: the delete removes every assignment to that customer, enabled or not, and says
 * how many it removed; a group left with no customer is sent nothing; the same group's other
 * customers and other recipients' assignments are untouched.
 *
 *   node scripts/test-customer-delete-removes-assignments.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_NOTIFY_MODE = 'dashboard';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cust-delete-'));

const assert = require('assert');
const http = require('http');
const { app, customerStore, requests, store } = require('../src/web/server');
const { toRecipientRows } = require('../src/model/project');

function req(method, url, { body = null, origin = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    if (origin) headers.origin = origin;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

let checks = 0;
const failures = [];
async function check(label, fn) {
  checks++;
  try { await fn(); console.log(`  ok  ${checks}. ${label}`); }
  catch (e) { failures.push(`${checks}. ${label} - ${e.message.split('\n')[0]}`); console.error(`  FAIL ${checks}. ${label} - ${e.message}`); }
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body = {}) => req('POST', base + p, { body: JSON.stringify(body), origin: base });
  const get = async (p) => (await req('GET', base + p)).json;

  const adama = await customerStore.upsert({ label: 'Delete Adama' });
  const durian = await customerStore.upsert({ label: 'Delete Durian' });

  const adamaGroup = (await post('/api/people', { name: 'BRL Bids - Adama', phone: '120363400000000001@g.us', alertPrefs: 'all' })).json.person;
  const sharedGroup = (await post('/api/people', { name: 'BRL Bids - Adama and Durian', phone: '120363400000000002@g.us', alertPrefs: 'all' })).json.person;
  const desk = (await post('/api/people', { name: 'Delete Desk', phone: '+919000000031', alertPrefs: 'all' })).json.person;

  await post('/api/assignments', { personId: adamaGroup.personId, customerId: adama.customerId });
  await post('/api/assignments', { personId: sharedGroup.personId, customerId: adama.customerId });
  await post('/api/assignments', { personId: sharedGroup.personId, customerId: durian.customerId });
  await post('/api/assignments', { personId: desk.personId, customerId: adama.customerId, enabled: false });
  await post('/api/assignments', { personId: desk.personId, customerId: durian.customerId });

  const res = await post(`/api/customers/${adama.customerId}/delete`);
  const { assignments } = await get('/api/assignments');
  const rows = toRecipientRows(await customerStore.list(), (await get('/api/people')).people, assignments);
  const rowOf = (p) => rows.find((r) => r.phone === p.phone);

  await check('the delete succeeds and reports the 3 assignments it removed', async () => {
    assert.strictEqual(res.status, 200, `status ${res.status}`);
    assert.strictEqual(res.json.removedAssignments, 3);
  });
  await check('no assignment points at the deleted customer, the disabled one included', async () => {
    assert.deepStrictEqual(assignments.filter((a) => a.customerId === adama.customerId), []);
  });
  await check('the other customer\'s assignments are untouched', async () => {
    assert.deepStrictEqual(assignments.map((a) => a.assignmentId).sort(),
      [`${sharedGroup.personId}::${durian.customerId}`, `${desk.personId}::${durian.customerId}`].sort());
  });
  await check('the group whose only customer was deleted is sent nothing', async () => {
    assert.strictEqual(rowOf(adamaGroup), undefined);
  });
  await check('the shared group still receives its other customer only', async () => {
    assert.deepStrictEqual(rowOf(sharedGroup).scope.shippers, ['Delete Durian']);
  });
  await check('an unknown customer id is still a 404', async () => {
    assert.strictEqual((await post('/api/customers/no-such-customer/delete')).status, 404);
  });

  // A write failure while removing the assignments must still answer, still audit, and still
  // refresh the cached model - otherwise discovery keeps matching the deleted customer.
  const kei = await customerStore.upsert({ label: 'Delete Kei Cables' });
  await post('/api/assignments', { personId: sharedGroup.personId, customerId: kei.customerId });
  await requests.createForLoad({
    id: 'DEL-KEI', lane: { origin: 'Alwar', destination: 'Pune' }, equipment: '32 Feet', units: 1, companyName: 'Delete Kei Cables',
    closesAt: Date.now() + 40 * 60_000, startsAt: Date.now() - 60_000, softClose: false, closeModelKnown: true, status: 'live',
    rules: { ceilingPrice: null, pricingMode: 'flat' },
  });
  const tagOf = async () => ((await get('/api/price-requests')).requests || []).find((r) => r.loadId === 'DEL-KEI');
  const before = await tagOf();
  const realRemove = store.removeDoc.bind(store);
  store.removeDoc = async (collection, id) => {
    if (collection === 'assignments') throw new Error('disk full');
    return realRemove(collection, id);
  };
  const failed = await post(`/api/customers/${kei.customerId}/delete`);
  store.removeDoc = realRemove;
  const after = await tagOf();

  await check('a cleanup failure answers 500 with a plain message instead of hanging', async () => {
    assert.strictEqual(failed.status, 500);
    assert.match(failed.json.error, /Delete Kei Cables was deleted, but cleaning up after it failed \(disk full\)/);
  });
  await check('the cached model is refreshed anyway: the load no longer matches the deleted customer', async () => {
    assert.ok(before && before.customer && before.customer.customerId === kei.customerId, `setup: tag was ${JSON.stringify(before && before.customer)}`);
    assert.strictEqual(after.customer, null);
  });
  await check('the leftover assignment sends the shared group nothing for the deleted customer', async () => {
    const left = (await get('/api/assignments')).assignments;
    assert.ok(left.some((a) => a.customerId === kei.customerId), 'setup: the failed remove left the assignment');
    const shared = toRecipientRows(await customerStore.list(), (await get('/api/people')).people, left).find((r) => r.phone === sharedGroup.phone);
    assert.deepStrictEqual(shared.scope.shippers, ['Delete Durian']);
  });

  server.close();
  console.log(`\n${checks - failures.length} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.error('  ' + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
