'use strict';
/**
 * A STORED BELOW-MINIMUM ASSIGNMENT OVERRIDE CAN BE RE-SAVED UNDER A DIFFERENT PERSON OR CUSTOMER.
 * (D2A-assignment-rebind)
 *
 * No one may set a band margin below the minimum margin; an override already stored that way is
 * tolerated only while it is carried along unchanged on its own assignment. AssignmentStore.upsert
 * looks up the stored record by the input's assignmentId, and validateAssignment exempts the input
 * band when it equals that record's marginOverride - but it takes personId and customerId from the
 * input body. So a raw POST /api/assignments naming a stored record's assignmentId with a different
 * personId or customerId passes the stored exemption and re-saves the below-minimum override under
 * a pairing that never had it.
 *
 * Fixture: people p1, p2 and customers c1, c2 all exist. Assignment p1::c1 carries
 * { marginsPct: [12.6, 7.2, 2], minMarginPct: 5 }, written straight to the store because
 * validation refuses it. On a 100000 cost that band's 2% step is 102000, below the 105000 minimum.
 *
 *   1. control: the stored override loads as written
 *   2. control: re-saving the same pairing, naming its assignmentId, with the stored band is accepted
 *   3. assignmentId p1::c1 with personId p2 carrying the stored band: refused, nothing written
 *   4. assignmentId p1::c1 with customerId c2 carrying the stored band: refused, nothing written
 *   5. assignmentId p1::c1 with personId p2 and customerId c2: refused, nothing written
 *   6. control: the stored band on a new pairing by its own natural key is refused
 *   7. control: a new band above the minimum is accepted on p2::c1, p1::c2 and p2::c2
 *   8. control: a new band above the minimum replaces the stored one on p1::c1
 *
 * Must NOT move: the same-pairing carry of a stored band (2), and new valid bands on any pairing
 * (7, 8). Offline and deterministic: memory store, no network, no timers.
 *
 *   node scripts/test-assignment-stored-override-not-rebound.js
 */
const assert = require('assert');
const { createStore } = require('../src/store');
const { CustomerStore } = require('../src/model/customerStore');
const { PersonStore } = require('../src/model/personStore');
const { AssignmentStore } = require('../src/model/assignmentStore');

let checks = 0;
const failures = [];
async function check(label, fn) {
  checks++;
  try { await fn(); console.log(`  ok  ${checks}. ${label}`); }
  catch (e) { failures.push(`${checks}. ${label}: ${e.message}`); console.error(`  FAIL ${checks}. ${label}: ${e.message}`); }
}

const STORED = { marginsPct: [12.6, 7.2, 2], minMarginPct: 5 };
// Lowest step 6.3 >= minimum 5, so validation accepts it as a new band.
const VALID = { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 5 };
const clone = (v) => JSON.parse(JSON.stringify(v));

async function refusal(fn) {
  try { await fn(); } catch (e) { return e; }
  return null;
}

(async () => {
  const store = createStore({ backend: 'memory' });
  const customers = new CustomerStore({ store });
  const people = new PersonStore({ store, accountsProvider: async () => [{ accountId: 'primary' }] });
  const assignments = new AssignmentStore({ store, people, customers });
  const c1 = (await customers.upsert({ label: 'ADAMA' })).customerId;
  const c2 = (await customers.upsert({ label: 'Borosil' })).customerId;
  const p1 = (await people.upsert({ name: 'Desk One', phone: '9000000001', accountId: 'primary' })).personId;
  const p2 = (await people.upsert({ name: 'Desk Two', phone: '9000000002', accountId: 'primary' })).personId;
  const STORED_ID = `${p1}::${c1}`;
  const storedDoc = {
    assignmentId: STORED_ID, personId: p1, customerId: c1, lanes: null,
    marginOverride: clone(STORED), alertKinds: null, enabled: true, owner: false, updatedAt: 1_700_000_000_000,
  };

  // Each case starts from the same single stored record, so one case's write cannot leak into the next.
  const reseed = async () => {
    for (const a of await assignments.list()) await assignments.remove(a.assignmentId);
    await store.putDoc('assignments', STORED_ID, clone(storedDoc));
  };
  const assertNothingWritten = async (where) => {
    const all = (await assignments.list()).map(clone);
    assert.deepStrictEqual(all.map((a) => a.assignmentId), [STORED_ID], `${where}: the assignment set changed to ${all.map((a) => a.assignmentId).join(', ')}`);
    assert.deepStrictEqual(all[0], storedDoc,
      `${where}: the stored record was rewritten as ${all[0].personId}::${all[0].customerId} with override ${JSON.stringify(all[0].marginOverride)}`);
  };
  const assertRebindRefused = async (input, where) => {
    await reseed();
    const err = await refusal(() => assignments.upsert(input));
    if (!err) {
      const after = await assignments.get(STORED_ID);
      assert.fail(`${where} ACCEPTED: the stored below-minimum override ${JSON.stringify(STORED.marginsPct)} min 5 was re-saved `
        + `under ${after.personId}::${after.customerId} (the stored-band exemption is keyed on assignmentId, not the pairing)`);
    }
    assert.strictEqual(err.code, 'BAD_INPUT', `${where} refused with ${err.code || 'no code'} (${err.message}), expected BAD_INPUT`);
    assert.ok(/below/i.test(err.message) && err.message.includes('5%'),
      `${where} refused, but not with the below-minimum message naming 5%: ${err.message}`);
    await assertNothingWritten(where);
  };

  console.log('\n-- the stored pairing keeps its stored band');
  await check('control: the stored below-minimum override loads as written', async () => {
    await reseed();
    assert.deepStrictEqual((await assignments.get(STORED_ID)).marginOverride, STORED);
  });
  await check('control: re-saving p1::c1 by its assignmentId with the stored band is accepted', async () => {
    await reseed();
    const saved = await assignments.upsert({
      assignmentId: STORED_ID, personId: p1, customerId: c1, marginOverride: clone(STORED), alertKinds: ['won', 'lost'],
    });
    assert.deepStrictEqual([saved.assignmentId, saved.personId, saved.customerId], [STORED_ID, p1, c1]);
    assert.deepStrictEqual(saved.alertKinds, ['won', 'lost']);
    assert.deepStrictEqual((await assignments.get(STORED_ID)).marginOverride, STORED);
  });

  console.log('\n-- the stored band cannot ride its assignmentId onto another pairing');
  await check('assignmentId p1::c1 with personId p2 carrying the stored band is refused and writes nothing', () =>
    assertRebindRefused({ assignmentId: STORED_ID, personId: p2, customerId: c1, marginOverride: clone(STORED) }, 'p2 under p1::c1'));
  await check('assignmentId p1::c1 with customerId c2 carrying the stored band is refused and writes nothing', () =>
    assertRebindRefused({ assignmentId: STORED_ID, personId: p1, customerId: c2, marginOverride: clone(STORED) }, 'c2 under p1::c1'));
  await check('assignmentId p1::c1 with personId p2 and customerId c2 carrying the stored band is refused and writes nothing', () =>
    assertRebindRefused({ assignmentId: STORED_ID, personId: p2, customerId: c2, marginOverride: clone(STORED) }, 'p2::c2 under p1::c1'));

  console.log('\n-- controls: M0 refusal and new valid bands');
  await check('control: the stored band on p2::c1 by its own natural key is refused and writes nothing', async () => {
    await reseed();
    const err = await refusal(() => assignments.upsert({ personId: p2, customerId: c1, marginOverride: clone(STORED) }));
    assert.ok(err && err.code === 'BAD_INPUT', `expected BAD_INPUT, got ${err ? `${err.code}: ${err.message}` : 'acceptance'}`);
    await assertNothingWritten('p2::c1 natural key');
  });
  await check('control: a new band above the minimum is accepted on p2::c1, p1::c2 and p2::c2', async () => {
    await reseed();
    for (const [personId, customerId] of [[p2, c1], [p1, c2], [p2, c2]]) {
      const saved = await assignments.upsert({ personId, customerId, marginOverride: clone(VALID) });
      assert.strictEqual(saved.assignmentId, `${personId}::${customerId}`);
      assert.deepStrictEqual((await assignments.get(`${personId}::${customerId}`)).marginOverride, VALID);
    }
    assert.deepStrictEqual((await assignments.get(STORED_ID)).marginOverride, STORED, 'saving other pairings touched p1::c1');
  });
  await check('control: a new band above the minimum replaces the stored one on p1::c1', async () => {
    await reseed();
    const saved = await assignments.upsert({ assignmentId: STORED_ID, personId: p1, customerId: c1, marginOverride: clone(VALID) });
    assert.deepStrictEqual(saved.marginOverride, VALID);
    assert.deepStrictEqual((await assignments.get(STORED_ID)).marginOverride, VALID);
  });

  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - a stored below-minimum assignment override is re-saved under a different personId/customerId (the stored-band exemption follows assignmentId, not the pairing):`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - a stored below-minimum assignment override stays on its own pairing`);
})().catch((e) => { console.error('FAIL (setup):', e && e.stack); process.exit(1); });
