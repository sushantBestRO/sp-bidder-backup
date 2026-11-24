'use strict';
/**
 * A BAND ALREADY STORED WITH A MARGIN BELOW ITS FLOOR MARGIN KEEPS WORKING.
 *
 * Refusing to SET a bid margin below the floor margin (scripts/test-band-margin-below-floor-refused.js)
 * does not clean up bands saved before that rule existed. On the box a customer carries
 * [12.6, 7.2, 0] with floor margin 5, and price requests have inherited it. Those bands must not
 * crash anything and must not be silently refused: at bid time they keep today's behaviour, where
 * the engine raises the low margin to cost x (1 + floorMargin/100).
 *
 * DESIGN DECISION pinned here: the new rule gates SETTING a band - a new band or a changed one. It
 * does not gate a save that carries a stored band along unchanged (an edit to a customer's aliases,
 * a settings panel that has nothing to do with margins, an assignment's alert kinds), nor a restore
 * of a band already saved (resuming a held load, capturing a cost on a request that inherited the
 * band, the boot-time copy of legacy margin profiles into customers). A fix that puts the check
 * inside validateMargins alone refuses all of those, because every one of them runs the stored band
 * back through validateMargins - and several do so on payloads the console builds itself by
 * re-sending the stored band. If that is the wanted behaviour, this file is the one to change.
 *
 * The violating documents are written straight to disk in the stores' own file layout, bypassing
 * validation, which is the only way such a band exists once the rule is in.
 *
 *   1. the stores load, list and get the stored band; boot's customer re-validation accepts it
 *   2. boot's one-time legacy migration copies a stored margin profile carrying such a band
 *   3. customer: adding an alias, console payload shape (the stored margin rides along)
 *   4. customer: disabling it, console payload shape
 *   5. settings: an allowlist-only save while the stored global band violates
 *   6. settings: the Settings panel save, which re-sends the stored band unchanged
 *   7. assignment: a coverage save that omits marginOverride (the stored one is carried forward)
 *   8. assignment: the override editor changing alert kinds, re-sending the stored band
 *   9. resuming a held load onto its saved violating band
 *  10. capturing a cost, no override, on a request that inherited the band
 *  11. the engine arms that request: every price >= 105000 on cost 100000, the 0% margin raised to it
 *
 * Offline and deterministic: file store in a temp dir under os.tmpdir(), fake adapter, no network,
 * no sleeps. The engine monitor is stopped before exit.
 *
 *   node scripts/test-stored-band-below-floor-tolerated.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { FileStore } = require('../src/store');
const { ConfigStore, defaultsFrom } = require('../src/admin/configStore');
const { CustomerStore } = require('../src/model/customerStore');
const { PersonStore } = require('../src/model/personStore');
const { AssignmentStore } = require('../src/model/assignmentStore');
const { assertCustomerRulesValid } = require('../src/model/rulesConfig');
const { migrateLegacyModel } = require('../src/model/migrate');
const { PriceRequestStore, armFromRequest } = require('../src/pricing/priceRequests');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'stored-band-below-floor-'));
const cleanup = () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {} };

let checks = 0;
const failures = [];
async function check(label, fn) {
  checks++;
  try { await fn(); console.log(`  ok  ${checks}. ${label}`); }
  catch (e) { failures.push(`${checks}. ${label}: ${e.message}`); console.error(`  FAIL ${checks}. ${label}: ${e.message}`); }
}

const STORED = { marginsPct: [12.6, 7.2, 0], minMarginPct: 5 };
const COMPANY = 'Adama India Private Limited';
const PERSON_ID = 'p919000000009';
const ASSIGNMENT_ID = `${PERSON_ID}::adama`;
const now = Date.now();

function writeCollection(dir, collection, docs) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${collection}.json`), JSON.stringify(docs, null, 2));
}

const mkLoad = (id) => ({
  id, lane: { origin: 'Bhiwandi', destination: 'Bawal' }, equipment: '32 Feet', units: 1,
  companyName: COMPANY, closesAt: now + 40 * 60_000, startsAt: now - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: null,
});

const baseConfig = {
  marginsPct: [12.6, 7.2, 5], minMarginPct: 5,
  allowlist: { shippers: [], lanes: [], hardCloseOnly: false },
  discoveryIntervalMs: 30000, priceDeadlineLeadMs: 35000, reminderLeadMs: 60000, notifyMode: 'dashboard',
};

(async () => {
  const dataDir = path.join(ROOT, 'data');
  writeCollection(dataDir, 'customers', {
    adama: {
      customerId: 'adama', label: 'ADAMA', aliases: ['ADAMA', COMPANY],
      margin: { ...STORED }, auction: null, enabled: true, updatedAt: now - 86_400_000, updatedBy: 'admin',
    },
  });
  writeCollection(dataDir, 'people', {
    [PERSON_ID]: {
      personId: PERSON_ID, name: 'Desk', phone: '+919000000009', email: null, accountId: 'primary',
      alertPrefs: 'all', alertAll: false, originScope: [], branchScope: [], enabled: true,
    },
  });
  writeCollection(dataDir, 'assignments', {
    [ASSIGNMENT_ID]: {
      assignmentId: ASSIGNMENT_ID, personId: PERSON_ID, customerId: 'adama', lanes: null,
      marginOverride: { ...STORED }, alertKinds: null, enabled: true, owner: false, updatedAt: now - 86_400_000,
    },
  });
  const storedConfig = Object.assign(defaultsFrom(baseConfig), { marginsPct: STORED.marginsPct.slice(), minMarginPct: 5 });
  writeCollection(dataDir, 'config', { current: storedConfig });

  const store = new FileStore({ dataDir });
  const customers = new CustomerStore({ store });
  const people = new PersonStore({ store, accountsProvider: async () => [{ accountId: 'primary' }] });
  const assignments = new AssignmentStore({ store, people, customers });
  const configStore = new ConfigStore({ store, defaults: defaultsFrom(baseConfig) });
  const requests = new PriceRequestStore({ store, marginsPct: [12.6, 7.2, 5], minMarginPct: 5,
    customersProvider: customers, assignmentsProvider: assignments });

  console.log('\n-- loading what is on disk');
  await check('the stores load, list and get the stored band; boot customer re-validation accepts it', async () => {
    const list = await customers.list();
    assert.deepStrictEqual(list.map((c) => c.customerId), ['adama']);
    assert.strictEqual(assertCustomerRulesValid(list), true);
    assert.deepStrictEqual((await customers.get('adama')).margin, STORED);
    assert.deepStrictEqual((await customers.getByAnyId('adama')).margin, STORED);
    assert.deepStrictEqual((await assignments.get(ASSIGNMENT_ID)).marginOverride, STORED);
    const cfg = await configStore.get();
    assert.deepStrictEqual([cfg.marginsPct, cfg.minMarginPct], [STORED.marginsPct, 5]);
    const inherited = await requests.resolveInherited(mkLoad('SB-RESOLVE'));
    assert.deepStrictEqual([inherited.marginsPct, inherited.minMarginPct], [STORED.marginsPct, 5]);
  });

  await check('boot legacy migration copies a stored margin profile whose band sits below its floor margin', async () => {
    const legacyDir = path.join(ROOT, 'legacy');
    writeCollection(legacyDir, 'marginProfiles', {
      'sp:adama': { platformKey: 'sp', customerKey: 'adama', customerLabel: 'ADAMA', ...STORED, enabled: true },
    });
    const legacyStore = new FileStore({ dataDir: legacyDir });
    const res = await migrateLegacyModel({ store: legacyStore });
    assert.strictEqual(res.ran, true, `migration did not run: ${JSON.stringify(res)}`);
    const migrated = await legacyStore.getDoc('customers', 'adama');
    assert.ok(migrated, 'the legacy profile was not copied into customers');
    assert.deepStrictEqual(migrated.margin, STORED);
  });

  console.log('\n-- unrelated edits that carry the stored band along unchanged');
  const consoleCustomerPayload = (c, over) => ({
    customerId: c.customerId, label: c.label, aliases: c.aliases.slice(),
    margin: { marginsPct: c.margin.marginsPct.slice(), minMarginPct: c.margin.minMarginPct },
    auction: c.auction, enabled: c.enabled, ...over,
  });
  await check('customer: adding an alias saves and leaves the stored band as it was', async () => {
    const c = await customers.get('adama');
    const saved = await customers.upsert(consoleCustomerPayload(c, { aliases: [...c.aliases, 'Adama India Pvt Ltd'] }));
    assert.ok(saved.aliases.includes('Adama India Pvt Ltd'));
    assert.deepStrictEqual((await customers.get('adama')).margin, STORED);
  });
  await check('customer: disabling it saves and leaves the stored band as it was', async () => {
    const c = await customers.get('adama');
    await customers.upsert(consoleCustomerPayload(c, { enabled: false }));
    const after = await customers.get('adama');
    assert.strictEqual(after.enabled, false);
    assert.deepStrictEqual(after.margin, STORED);
    await customers.upsert(consoleCustomerPayload(after, { enabled: true }));
  });

  await check('settings: an allowlist-only save succeeds while the stored global band violates', async () => {
    const next = await configStore.save({ allowlist: { shippers: ['ADAMA'] } });
    assert.deepStrictEqual(next.allowlist.shippers, ['ADAMA']);
    assert.deepStrictEqual([next.marginsPct, next.minMarginPct], [STORED.marginsPct, 5]);
  });
  await check('settings: the Settings panel save re-sending the stored band unchanged succeeds', async () => {
    const cur = await configStore.get();
    const next = await configStore.save({
      marginsPct: cur.marginsPct.map(Number), minMarginPct: Number(cur.minMarginPct),
      discoveryIntervalMs: 45000, priceDeadlineLeadMs: cur.priceDeadlineLeadMs, reminderLeadMs: cur.reminderLeadMs,
      antiDetection: { ...cur.antiDetection },
    });
    assert.strictEqual(next.discoveryIntervalMs, 45000);
    assert.deepStrictEqual([next.marginsPct, next.minMarginPct], [STORED.marginsPct, 5]);
  });

  await check('assignment: a coverage save omitting marginOverride succeeds and keeps the stored override', async () => {
    const saved = await assignments.upsert({ personId: PERSON_ID, customerId: 'adama', lanes: ['Bhiwandi'] });
    assert.deepStrictEqual(saved.lanes, ['Bhiwandi']);
    assert.deepStrictEqual((await assignments.get(ASSIGNMENT_ID)).marginOverride, STORED);
  });
  await check('assignment: changing alert kinds while re-sending the stored override succeeds', async () => {
    const a = await assignments.get(ASSIGNMENT_ID);
    const saved = await assignments.upsert({
      personId: PERSON_ID, customerId: 'adama',
      marginOverride: { marginsPct: a.marginOverride.marginsPct.slice(), minMarginPct: a.marginOverride.minMarginPct },
      alertKinds: ['won', 'lost'], lanes: a.lanes || null, enabled: true,
    });
    assert.deepStrictEqual(saved.alertKinds, ['won', 'lost']);
    assert.deepStrictEqual(saved.marginOverride, STORED);
  });

  console.log('\n-- restores and bids of the stored band');
  await check('resuming a held load onto its saved violating band succeeds', async () => {
    const created = await requests.createForLoad(mkLoad('SB-RESUME'), { deadlineAt: now + 30 * 60_000 });
    await store.patchDoc('priceRequests', created.id, {
      status: 'armed', ...STORED, marginSource: `assignment:${ASSIGNMENT_ID}`,
      price: { cost: 90000, ...STORED },
      hold: { kind: 'standing', at: now - 60_000,
        resume: { cost: 100000, ...STORED, marginSource: `assignment:${ASSIGNMENT_ID}`, marginOverride: null } },
    });
    const resumed = await requests.resumeBidding(created.id);
    assert.strictEqual(resumed.hold, null);
    assert.strictEqual(resumed.price.cost, 100000);
    assert.deepStrictEqual([resumed.price.marginsPct, resumed.price.minMarginPct], [STORED.marginsPct, 5]);
  });

  let captured = null;
  await check('capturing a cost with no override on a request that inherited the band arms it', async () => {
    const created = await requests.createForLoad(mkLoad('SB-CAPTURE'), { deadlineAt: now + 30 * 60_000 });
    assert.deepStrictEqual([created.marginsPct, created.minMarginPct], [STORED.marginsPct, 5], 'fixture: the request did not inherit the stored band');
    captured = await requests.capture(created.id, { cost: 100000 });
    assert.strictEqual(captured.status, 'armed');
    assert.deepStrictEqual([captured.price.marginsPct, captured.price.minMarginPct], [STORED.marginsPct, 5]);
  });

  await check('the engine arms it with every price >= 105000 and the 0% margin raised to 105000', async () => {
    assert.ok(captured, 'no captured request to arm (the capture check failed)');
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => ({ ok: false }),
      placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
    };
    const engine = new BidEngine(adapter, new DurableScheduler(path.join(ROOT, 'intents.json')), {
      config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 }, rand: () => 0.5,
    });
    let monitor;
    try {
      monitor = armFromRequest(engine, captured);
      assert.ok(monitor && Array.isArray(monitor.ladder) && monitor.ladder.length, 'armFromRequest armed no monitor');
      assert.strictEqual(monitor.floor, 105000, `floor ${monitor.floor}, expected cost 100000 x 1.05 = 105000`);
      assert.ok(monitor.ladder.every((p) => p >= 105000), `a price below 105000 was armed: ${monitor.ladder.join(', ')}`);
      assert.strictEqual(monitor.ladder[monitor.ladder.length - 1], 105000, `the lowest rung is ${monitor.ladder[monitor.ladder.length - 1]}, not 105000`);
      assert.ok(!monitor.ladder.includes(100000), 'the 0% margin was armed at cost');
    } finally {
      engine.stop(captured.loadId);
    }
  });

  cleanup();
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - a band stored below its floor margin is refused or mis-bid on a save, restore or arm that did not set it:`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - a stored band below its floor margin loads, survives unrelated saves and restores, and bids at or above the floor`);
})().catch((e) => { cleanup(); console.error('FAIL (setup):', e && e.stack); process.exit(1); });
