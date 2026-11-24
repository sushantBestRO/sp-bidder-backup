'use strict';
/**
 * A PRICE REQUEST THAT REACHES NOBODY MUST NOT READ AS DELIVERED. (CW-145 / G9)
 *
 * notifier.js's `_whatsapp` treated a price_needed push that matched ZERO recipients exactly like
 * an ordinary successful send: return true. discovery.js then called markNotified(true), so the
 * request was marked notified, the desk was never asked to price it, and nothing ever retried or
 * said so - a routing-config gap (no group or person scope covers this customer) read as a clean
 * delivery. This is the money-reliability defect CW-145/G9 exists to close: 235 asks reached no
 * group in one 8-day window per the participation audit.
 *
 * THE FIX, in three parts:
 *   - notifier.js: `_whatsapp` returns the string 'unreached' (not true) for price_needed's own
 *     zero-match case - a value discovery.js can tell apart from both a real send (true) and a
 *     sender-down skip (false).
 *   - priceRequests.js: markReachedNobody(token) sets reachedNobody/reachedNobodyAt WITHOUT
 *     touching notified, so the retry loop keeps trying every tick; markNotified clears the flag
 *     the moment a later attempt actually lands.
 *   - discovery.js: routes 'unreached' to markReachedNobody + a loud, per-request-deduped 'error'
 *     alert naming the customer and the load, instead of markNotified.
 *
 * The console badge itself is UI (PR-3) - out of scope here. This only proves the stored state is
 * honest and readable (the existing GET /api/price-requests spreads the whole stored doc, so no
 * server.js change was needed) and that the alert actually fires.
 *
 *   1-2. notifier.requestPrice returns delivered:'unreached' on zero recipients, delivered:true on
 *        a real match (control - delivery to a matching recipient is unchanged)
 *   3. notifier.remindApproaching gets the same treatment
 *   4. discovery: a new load with zero matching recipients creates a request that stays
 *      notified:false, reachedNobody:true, with a reachedNobodyAt timestamp
 *   5. exactly one 'error'-kind WhatsApp send reaches the ops recipient, naming the shipper and
 *      the load id
 *   6. the request is durable and restart-safe: a fresh read off disk carries reachedNobody:true
 *   7. repeated ticks re-attempt (still notified:false) but the alert does not repeat (real
 *      notifier dedupe on a stable key)
 *   8. control: a load whose shipper DOES match a subscribed recipient is unaffected - notified:
 *      true, reachedNobody stays false, no error alert
 *   9. once the routing gap is fixed (recipients now match), the very next tick clears
 *      reachedNobody and marks notified - the record self-heals without operator action
 *
 * Offline and deterministic: real Notifier + real WhatsAppClient over a capturing fake transport
 * (recipients/scope drive matching, not a live board) + real DiscoveryPoller + PriceRequestStore +
 * FileStore on a temp dir under os.tmpdir(), removed at the end. No network, no sleeps.
 *
 *   node scripts/test-price-needed-zero-recipients-alerts-and-holds.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp dataDir), not app state
const path = require('path');
const assert = require('assert');
const { FileStore } = require('../src/store/fileStore');
const { MemoryStore } = require('../src/store');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { DiscoveryPoller } = require('../src/discovery/discovery');
const { Notifier } = require('../src/notify/notifier');
const { WhatsAppClient } = require('../src/notify/whatsapp');

let checks = 0;
const failures = [];
async function check(label, fn) {
  checks++;
  try { await fn(); console.log(`  ok  ${checks}. ${label}`); }
  catch (e) { failures.push(`${checks}. ${label}: ${e.message}`); console.error(`  FAIL ${checks}. ${label}: ${e.message}`); }
}
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`); } else { fail++; console.error(`  FAIL ${m}`); } };

const HOUR = 3_600_000;
const SHIPPER = 'Ashirvad Pipes Ltd';
const OTHER_SHIPPER = 'Havells India Ltd';
const DIRS = [];
const cleanup = () => { for (const d of DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } };

function scheduledLoad(id, companyName, closesAt) {
  return {
    id, lane: { origin: 'Bhiwandi, Maharashtra', destination: 'Silvassa, DNH' }, equipment: '20 ft SXL',
    units: 1, companyName, shipmentType: 'FTL', closesAt, startsAt: closesAt - 2 * HOUR,
    status: 'live', softClose: false, closeModelKnown: true, closeModel: 'hard',
  };
}
function storedRequest(id, loadId, companyName) {
  return { id, loadId, load: { companyName } };
}

function fakeWaTransport() {
  const sends = [];
  const transport = async (url, opts) => {
    sends.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) };
  };
  return { sends, transport };
}

function makeNotifier({ recipients }) {
  const { sends, transport } = fakeWaTransport();
  const wa = new WhatsAppClient({ enabled: true, transport, token: 't', productId: 'p', phoneId: '128023' });
  const notifier = new Notifier({
    mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa,
    store: new MemoryStore(), recipientsProvider: async () => recipients, healthProvider: async () => true,
  });
  return { notifier, sends };
}

// Nobody is subscribed to price_needed for SHIPPER; Ops takes error, unscoped.
const UNREACHED_RECIPIENTS = [
  { name: 'Some other desk', phone: '919000000001', alerts: ['price_needed'], scope: { shippers: [OTHER_SHIPPER] } },
  { name: 'Ops', phone: '919000000009', alerts: ['error'] },
];
// SHIPPER now matches a subscribed recipient too - the routing gap is fixed.
const MATCHED_RECIPIENTS = [
  { name: 'Ashirvad desk', phone: '919000000002', alerts: ['price_needed'], scope: { shippers: [SHIPPER] } },
  { name: 'Ops', phone: '919000000009', alerts: ['error'] },
];

(async () => {
  console.log('\n-- notifier.js: the return value itself');
  await check('requestPrice returns delivered:\'unreached\' when the price ask matches zero recipients', async () => {
    const { notifier } = makeNotifier({ recipients: UNREACHED_RECIPIENTS });
    const res = await notifier.requestPrice(storedRequest('t1', 'SP111', SHIPPER));
    assert.strictEqual(res.delivered, 'unreached', `expected 'unreached', got ${JSON.stringify(res.delivered)}`);
  });
  await check('control: requestPrice returns delivered:true when a recipient DOES match', async () => {
    const { notifier } = makeNotifier({ recipients: MATCHED_RECIPIENTS });
    const res = await notifier.requestPrice(storedRequest('t2', 'SP112', SHIPPER));
    assert.strictEqual(res.delivered, true, `expected true, got ${JSON.stringify(res.delivered)}`);
  });
  await check('remindApproaching gets the same treatment on zero recipients', async () => {
    const { notifier } = makeNotifier({ recipients: UNREACHED_RECIPIENTS });
    const res = await notifier.remindApproaching(storedRequest('t3', 'SP113', SHIPPER));
    assert.strictEqual(res.delivered, 'unreached', `expected 'unreached', got ${JSON.stringify(res.delivered)}`);
  });

  console.log('\n-- discovery: a load that reaches nobody stays retryable and gets a loud alert');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'price-needed-unreached-'));
    DIRS.push(dir);
    const store = new FileStore({ dataDir: dir, logDir: path.join(dir, 'logs') });
    const requests = new PriceRequestStore({ store, marginsPct: [9, 5, 1], minMarginPct: 1, platformKey: 'sp' });
    const { notifier, sends } = makeNotifier({ recipients: UNREACHED_RECIPIENTS });
    const closesAt = Date.now() + 3 * HOUR;
    const listing = [scheduledLoad('SP920001', SHIPPER, closesAt)];
    const poller = new DiscoveryPoller({
      adapter: { listAuctions: async () => listing }, requests, notifier, platformKey: 'sp',
      config: { allowlist: { shippers: [SHIPPER, OTHER_SHIPPER] } },
    });

    const r1 = await poller.tick();
    ok(r1.created === 1, `4a. the load still creates a price request (got ${JSON.stringify(r1)})`);
    let onDisk = (await requests.listAll()).find((r) => r.loadId === 'SP920001');
    ok(!!onDisk, '4b. the request is on disk');
    ok(onDisk.notified === false, `4c. notified stays false (got ${onDisk.notified})`);
    ok(onDisk.reachedNobody === true, `4d. reachedNobody is set (got ${onDisk.reachedNobody})`);
    ok(typeof onDisk.reachedNobodyAt === 'number', `4e. reachedNobodyAt is a timestamp (got ${onDisk.reachedNobodyAt})`);

    const errorSends = sends.filter((s) => typeof s.message === 'string' && /Ashirvad Pipes Ltd/.test(s.message) && /SP920001/.test(s.message));
    ok(errorSends.length === 1, `5. exactly one WhatsApp send names the shipper and the load (got ${errorSends.length} of ${sends.length} total sends)`);

    console.log('\n-- durability: a fresh store read off the same disk carries the flag');
    const store2 = new FileStore({ dataDir: dir, logDir: path.join(dir, 'logs') });
    const requests2 = new PriceRequestStore({ store: store2, marginsPct: [9, 5, 1], minMarginPct: 1, platformKey: 'sp' });
    const fromDisk = (await requests2.listAll()).find((r) => r.loadId === 'SP920001');
    ok(fromDisk.reachedNobody === true, `6. a fresh read carries reachedNobody:true (got ${fromDisk.reachedNobody})`);

    console.log('\n-- repeated ticks retry but do not repeat the alert');
    await poller.tick();
    await poller.tick();
    const afterRepeat = (await requests.listAll()).find((r) => r.loadId === 'SP920001');
    ok(afterRepeat.notified === false, `7a. still not marked notified after repeated ticks (got ${afterRepeat.notified})`);
    ok(afterRepeat.reachedNobody === true, '7b. still flagged reached-nobody');
    const errorSendsAfter = sends.filter((s) => typeof s.message === 'string' && /Ashirvad Pipes Ltd/.test(s.message) && /SP920001/.test(s.message));
    ok(errorSendsAfter.length === 1, `7c. the alert did not repeat across three ticks (got ${errorSendsAfter.length})`);
  }

  console.log('\n-- control: a load that DOES reach a recipient is unaffected');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'price-needed-matched-'));
    DIRS.push(dir);
    const store = new FileStore({ dataDir: dir, logDir: path.join(dir, 'logs') });
    const requests = new PriceRequestStore({ store, marginsPct: [9, 5, 1], minMarginPct: 1, platformKey: 'sp' });
    const { notifier, sends } = makeNotifier({ recipients: MATCHED_RECIPIENTS });
    const closesAt = Date.now() + 3 * HOUR;
    const listing = [scheduledLoad('SP920002', SHIPPER, closesAt)];
    const poller = new DiscoveryPoller({
      adapter: { listAuctions: async () => listing }, requests, notifier, platformKey: 'sp',
      config: { allowlist: { shippers: [SHIPPER] } },
    });
    await poller.tick();
    const rec = (await requests.listAll()).find((r) => r.loadId === 'SP920002');
    ok(rec.notified === true, `8a. a matched load is marked notified (got ${rec.notified})`);
    ok(rec.reachedNobody === false, `8b. reachedNobody stays false for a matched load (got ${rec.reachedNobody})`);
    const errorSends = sends.filter((s) => typeof s.message === 'string' && /Ashirvad Pipes Ltd/.test(s.message) && s.to_number === '919000000009');
    ok(errorSends.length === 0, `8c. no error alert fires for a load that reaches its desk (got ${errorSends.length})`);
  }

  console.log('\n-- self-heal: a fixed routing gap clears the flag on the very next tick');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'price-needed-selfheal-'));
    DIRS.push(dir);
    const store = new FileStore({ dataDir: dir, logDir: path.join(dir, 'logs') });
    const requests = new PriceRequestStore({ store, marginsPct: [9, 5, 1], minMarginPct: 1, platformKey: 'sp' });
    let recipients = UNREACHED_RECIPIENTS;
    const { transport } = fakeWaTransport();
    const wa = new WhatsAppClient({ enabled: true, transport, token: 't', productId: 'p', phoneId: '128023' });
    const notifier = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa,
      store: new MemoryStore(), recipientsProvider: async () => recipients, healthProvider: async () => true,
    });
    const closesAt = Date.now() + 3 * HOUR;
    const listing = [scheduledLoad('SP920003', SHIPPER, closesAt)];
    const poller = new DiscoveryPoller({
      adapter: { listAuctions: async () => listing }, requests, notifier, platformKey: 'sp',
      config: { allowlist: { shippers: [SHIPPER] } },
    });
    await poller.tick();
    let rec = (await requests.listAll()).find((r) => r.loadId === 'SP920003');
    assert.strictEqual(rec.reachedNobody, true, 'setup: the load starts out reaching nobody');

    recipients = MATCHED_RECIPIENTS; // the operator fixes the routing config
    await poller.tick();
    rec = (await requests.listAll()).find((r) => r.loadId === 'SP920003');
    ok(rec.notified === true, `9a. the fixed routing marks the request notified on the very next tick (got ${rec.notified})`);
    ok(rec.reachedNobody === false, `9b. reachedNobody clears the moment a real send lands (got ${rec.reachedNobody})`);
  }

  cleanup();
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} check() blocks failed:`);
    for (const f of failures) console.error('  ' + f);
  }
  console.log(`\n${pass} passed, ${fail} failed (plus ${checks - failures.length}/${checks} check() blocks)`);
  if (fail || failures.length) process.exit(1);
})().catch((e) => { cleanup(); console.error('FAIL (setup):', e && e.stack); process.exit(1); });
