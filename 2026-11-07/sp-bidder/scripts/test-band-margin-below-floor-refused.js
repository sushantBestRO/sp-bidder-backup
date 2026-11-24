'use strict';
/**
 * A BID MARGIN BELOW THE FLOOR MARGIN CAN BE SET ON EVERY WRITE PATH.
 *
 * minMarginPct is the floor margin: the engine never bids below cost x (1 + minMarginPct/100). It is
 * a guard, not a bid - the three band margins are what the desk bids. So no one may SET a band
 * margin below it. validateMargins, the one validator every write path shares, checks shape only
 * and never compares the band to the floor margin, so validateMargins([15.3, 10.8, 2], 4.7) passes
 * and a band like [12.6, 7.2, 2] with floor 5 saves on every path below. At bid time the engine
 * quietly lifts the 2% margin to the floor, so the desk sees a margin in the console that is never
 * bid.
 *
 * One numbered section per write path, each driven through the store method its console route
 * delegates to (the routes add no margin check of their own):
 *   1. validateMargins itself - refuses with BAD_INPUT and names the floor margin in the message
 *   2. settings save            ConfigStore.save              (POST /api/config)
 *   3. customer save            CustomerStore.upsert          (POST /api/customers, /api/margin-profiles)
 *   4. legacy margin profile    MarginProfileStore.upsert
 *   5. assignment save          AssignmentStore.upsert        (POST /api/assignments)
 *   6. per-load capture         PriceRequestStore.capture     (POST /price/:token, JSON marginOverride)
 *   7. per-load re-price        PriceRequestStore.setBidOverride (POST /api/price-requests/:id/margin)
 *
 * Each section also carries two CONTROLS that pass today and must keep passing: a lowest margin
 * EQUAL to the floor margin ([12.6, 7.2, 5] floor 5), and a floor margin below every margin
 * ([15.3, 10.8, 4.5] floor 3). A fix that refuses either has gone too far.
 *
 * Offline and deterministic: memory store, no network, no timers.
 *
 *   node scripts/test-band-margin-below-floor-refused.js
 */
const assert = require('assert');
const { createStore } = require('../src/store');
const { validateMargins } = require('../src/pricing/marginValidate');
const { ConfigStore, defaultsFrom } = require('../src/admin/configStore');
const { CustomerStore } = require('../src/model/customerStore');
const { PersonStore } = require('../src/model/personStore');
const { AssignmentStore } = require('../src/model/assignmentStore');
const { MarginProfileStore } = require('../src/pricing/marginProfiles');
const { PriceRequestStore } = require('../src/pricing/priceRequests');

let checks = 0;
const failures = [];
async function check(label, fn) {
  checks++;
  try { await fn(); console.log(`  ok  ${checks}. ${label}`); }
  catch (e) { failures.push(`${checks}. ${label}: ${e.message}`); console.error(`  FAIL ${checks}. ${label}: ${e.message}`); }
}

const BELOW = { marginsPct: [12.6, 7.2, 2], minMarginPct: 5 };
const EQUAL = { marginsPct: [12.6, 7.2, 5], minMarginPct: 5 };
const UNDER_ALL = { marginsPct: [15.3, 10.8, 4.5], minMarginPct: 3 };

async function refusal(fn) {
  try { await fn(); } catch (e) { return e; }
  return null;
}
function assertRefused(err, where) {
  assert.ok(err, `${where} ACCEPTED a bid margin of 2% below the floor margin of 5% (validateMargins never compares the band to minMarginPct)`);
  assert.strictEqual(err.code, 'BAD_INPUT', `${where} refused with ${err.code || 'no code'} (${err.message}), expected BAD_INPUT`);
}

const now = Date.now();
const mkLoad = (id) => ({
  id, lane: { origin: 'Bhiwandi', destination: 'Bawal' }, equipment: '32 Feet', units: 1,
  companyName: 'Adama India Private Limited', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: null,
});

(async () => {
  console.log('\n1. validateMargins');
  await check('a margin below the floor margin is refused with BAD_INPUT naming the floor margin', () => {
    const err = (() => { try { validateMargins([15.3, 10.8, 2], 4.7); } catch (e) { return e; } return null; })();
    assert.ok(err, 'validateMargins([15.3, 10.8, 2], 4.7) ACCEPTED a 2% margin below the 4.7% floor margin');
    assert.strictEqual(err.code, 'BAD_INPUT', `refused with ${err.code || 'no code'}, expected BAD_INPUT`);
    assert.ok(err.message.includes('4.7'), `the refusal does not name the floor margin 4.7: "${err.message}"`);
  });
  await check('control: a lowest margin equal to the floor margin is accepted', () => {
    assert.deepStrictEqual(validateMargins([12.6, 7.2, 5], 5), EQUAL);
  });
  await check('control: a floor margin below every margin is accepted', () => {
    assert.deepStrictEqual(validateMargins([15.3, 10.8, 4.5], 3), UNDER_ALL);
  });

  console.log('\n2. settings save (ConfigStore.save)');
  {
    const defaults = defaultsFrom({
      marginsPct: [12.6, 7.2, 5], minMarginPct: 5,
      allowlist: { shippers: [], lanes: [], hardCloseOnly: false },
      discoveryIntervalMs: 30000, priceDeadlineLeadMs: 35000, reminderLeadMs: 60000, notifyMode: 'dashboard',
    });
    const cs = new ConfigStore({ store: createStore({ backend: 'memory' }), defaults });
    await check('settings save refuses a band margin below the floor margin', async () => {
      assertRefused(await refusal(() => cs.save({ ...BELOW })), 'settings save');
      assert.deepStrictEqual((await cs.get()).marginsPct, [12.6, 7.2, 5], 'the refused band was persisted anyway');
    });
    await check('control: settings save accepts a lowest margin equal to the floor margin', async () => {
      const next = await cs.save({ ...EQUAL });
      assert.deepStrictEqual([next.marginsPct, next.minMarginPct], [EQUAL.marginsPct, 5]);
    });
    await check('control: settings save accepts a floor margin below every margin', async () => {
      const next = await cs.save({ ...UNDER_ALL });
      assert.deepStrictEqual([next.marginsPct, next.minMarginPct], [UNDER_ALL.marginsPct, 3]);
    });
  }

  console.log('\n3. customer save (CustomerStore.upsert)');
  {
    const customers = new CustomerStore({ store: createStore({ backend: 'memory' }) });
    await check('customer save refuses a band margin below the floor margin', async () => {
      assertRefused(await refusal(() => customers.upsert({ label: 'ADAMA', margin: { ...BELOW } })), 'customer save');
      assert.strictEqual(await customers.get('adama'), null, 'the refused customer band was persisted anyway');
    });
    await check('control: customer save accepts a lowest margin equal to the floor margin', async () => {
      const c = await customers.upsert({ label: 'ADAMA', margin: { ...EQUAL } });
      assert.deepStrictEqual(c.margin, EQUAL);
    });
    await check('control: customer save accepts a floor margin below every margin', async () => {
      const c = await customers.upsert({ label: 'Borosil', margin: { ...UNDER_ALL } });
      assert.deepStrictEqual(c.margin, UNDER_ALL);
    });
  }

  console.log('\n4. legacy margin profile (MarginProfileStore.upsert)');
  {
    const profiles = new MarginProfileStore({ store: createStore({ backend: 'memory' }) });
    await check('margin-profile save refuses a band margin below the floor margin', async () => {
      assertRefused(await refusal(() => profiles.upsert({ platformKey: 'sp', customer: 'ADAMA', ...BELOW })), 'margin-profile save');
      assert.strictEqual(await profiles.get('sp', 'adama'), null, 'the refused profile was persisted anyway');
    });
    await check('control: margin-profile save accepts a lowest margin equal to the floor margin', async () => {
      const p = await profiles.upsert({ platformKey: 'sp', customer: 'ADAMA', ...EQUAL });
      assert.deepStrictEqual([p.marginsPct, p.minMarginPct], [EQUAL.marginsPct, 5]);
    });
    await check('control: margin-profile save accepts a floor margin below every margin', async () => {
      const p = await profiles.upsert({ platformKey: 'sp', customer: 'Borosil', ...UNDER_ALL });
      assert.deepStrictEqual([p.marginsPct, p.minMarginPct], [UNDER_ALL.marginsPct, 3]);
    });
  }

  console.log('\n5. assignment save (AssignmentStore.upsert)');
  {
    const store = createStore({ backend: 'memory' });
    const customers = new CustomerStore({ store });
    const people = new PersonStore({ store, accountsProvider: async () => [{ accountId: 'primary' }] });
    const assignments = new AssignmentStore({ store, people, customers });
    const cust = await customers.upsert({ label: 'ADAMA' });
    const per = await people.upsert({ name: 'Desk', phone: '9000000009', accountId: 'primary' });
    const ids = { personId: per.personId, customerId: cust.customerId };
    await check('assignment save refuses a band margin below the floor margin', async () => {
      assertRefused(await refusal(() => assignments.upsert({ ...ids, marginOverride: { ...BELOW } })), 'assignment save');
      assert.strictEqual(await assignments.get(`${ids.personId}::${ids.customerId}`), null, 'the refused assignment was persisted anyway');
    });
    await check('control: assignment save accepts a lowest margin equal to the floor margin', async () => {
      const a = await assignments.upsert({ ...ids, marginOverride: { ...EQUAL } });
      assert.deepStrictEqual(a.marginOverride, EQUAL);
    });
    await check('control: assignment save accepts a floor margin below every margin', async () => {
      const a = await assignments.upsert({ ...ids, marginOverride: { ...UNDER_ALL } });
      assert.deepStrictEqual(a.marginOverride, UNDER_ALL);
    });
  }

  console.log('\n6. per-load capture with a margin override (PriceRequestStore.capture)');
  {
    const requests = new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: [12.6, 7.2, 5], minMarginPct: 5 });
    const open = async (id) => (await requests.createForLoad(mkLoad(id), { deadlineAt: now + 30 * 60_000 })).id;
    await check('capture refuses an override band margin below the floor margin', async () => {
      const token = await open('BF-CAP-BELOW');
      assertRefused(await refusal(() => requests.capture(token, { cost: 100000, marginOverride: { ...BELOW } })), 'capture override');
      assert.strictEqual((await requests.getByToken(token)).status, 'awaiting_price', 'the refused capture armed the load anyway');
    });
    await check('control: capture accepts an override whose lowest margin equals the floor margin', async () => {
      const r = await requests.capture(await open('BF-CAP-EQUAL'), { cost: 100000, marginOverride: { ...EQUAL } });
      assert.deepStrictEqual([r.status, r.marginsPct, r.minMarginPct], ['armed', EQUAL.marginsPct, 5]);
    });
    await check('control: capture accepts an override whose floor margin is below every margin', async () => {
      const r = await requests.capture(await open('BF-CAP-UNDER'), { cost: 100000, marginOverride: { ...UNDER_ALL } });
      assert.deepStrictEqual([r.status, r.marginsPct, r.minMarginPct], ['armed', UNDER_ALL.marginsPct, 3]);
    });
  }

  console.log('\n7. per-load re-price margin override (PriceRequestStore.setBidOverride)');
  {
    const requests = new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: [12.6, 7.2, 5], minMarginPct: 5 });
    const open = async (id) => (await requests.createForLoad(mkLoad(id), { deadlineAt: now + 30 * 60_000 })).id;
    await check('margin override refuses a band margin below the floor margin', async () => {
      const token = await open('BF-OVR-BELOW');
      assertRefused(await refusal(() => requests.setBidOverride(token, { ...BELOW })), 'margin override');
      assert.strictEqual((await requests.getByToken(token)).marginOverride, null, 'the refused override was persisted anyway');
    });
    await check('control: margin override accepts a lowest margin equal to the floor margin', async () => {
      const r = await requests.setBidOverride(await open('BF-OVR-EQUAL'), { ...EQUAL });
      assert.deepStrictEqual([r.marginsPct, r.minMarginPct], [EQUAL.marginsPct, 5]);
    });
    await check('control: margin override accepts a floor margin below every margin', async () => {
      const r = await requests.setBidOverride(await open('BF-OVR-UNDER'), { ...UNDER_ALL });
      assert.deepStrictEqual([r.marginsPct, r.minMarginPct], [UNDER_ALL.marginsPct, 3]);
    });
  }

  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - a bid margin below the floor margin is still accepted on a write path (validateMargins checks shape only):`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - every write path refuses a bid margin below the floor margin and accepts one at or above it`);
})().catch((e) => { console.error('FAIL (setup):', e && e.stack); process.exit(1); });
