'use strict';
/**
 * A CUSTOMER'S MARGIN BAND CARRIES A PLATFORM DIMENSION; WITHOUT ONE, NOTHING CHANGES.
 *
 * Regression target: C055. resolveMargin ignored platformKey whenever a customer matched, so a
 * GoComet load inherited the band tuned for SuperProcure (unlimited revisions, Rs 100 decrement) on a
 * portal with a 3-revision budget and a Rs 1,000 minimum decrement, with no way to express another.
 *
 * Owner's default, pinned here:
 *   - a customer may carry `marginByPlatform: { <platformKey>: { marginsPct, minMarginPct } }`; a load
 *     on that platform bids that band in place of the customer's shared band. The tier order is
 *     unchanged: bid override > assignment override > customer band > default;
 *   - a load with no band of its own platform falls back to the customer's existing band, so the
 *     resolved band for EVERY existing record (none carries the new field) is byte-identical to the
 *     band f04380c resolved - proven below against a verbatim copy of the f04380c resolver over a
 *     seeded corpus, on both platforms;
 *   - the band is validated like every other band, and a console save that does not send the field
 *     keeps the stored one.
 *
 *   node scripts/test-customer-band-platform.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_NOTIFY_MODE = 'dashboard';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-band-platform-'));

const http = require('http');
const { resolveMargin, matchCustomer } = require('../src/model/resolve');
const { resolveBand } = require('../src/pricing/marginResolver');
const { validateCustomer } = require('../src/model/customerStore');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { MemoryStore } = require('../src/store/memoryStore');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };
const defaults = { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 };

// The resolver exactly as it stood at f04380c (src/model/resolve.js:82-94), the oracle for "unchanged".
function resolveMarginF04380c({ platformKey, companyName, customers, assignments, defaults: d }) {
  const customer = matchCustomer(companyName, customers);
  if (customer) {
    let ov = null;
    for (const a of (assignments || [])) {
      if (!a || a.enabled === false || a.customerId !== customer.customerId || !a.marginOverride) continue;
      if (!ov || (a.updatedAt || 0) > (ov.updatedAt || 0)) ov = a;
    }
    if (ov) return { marginsPct: ov.marginOverride.marginsPct.slice(), minMarginPct: ov.marginOverride.minMarginPct, source: `assignment:${ov.assignmentId}` };
    if (customer.margin) return { marginsPct: customer.margin.marginsPct.slice(), minMarginPct: customer.margin.minMarginPct, source: `customer:${customer.customerId}` };
  }
  return resolveBand({ platformKey, companyName, profiles: [], defaults: d });
}

let seed = 55;
const rnd = (n) => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (((t ^ (t >>> 14)) >>> 0) % n);
};
const band = () => { const lo = 1 + rnd(8); const n = 1 + rnd(4); const m = []; for (let i = 0; i < n; i++) m.push(lo + (n - 1 - i) * (1 + rnd(3))); return { marginsPct: m, minMarginPct: lo }; };
const names = ['Havells', 'Havells India', 'Tata Steel', 'Tata', 'Waaree Energies', 'Renewsys', 'Kingspan', 'Parijat'];

console.log('\n1. every existing record resolves exactly as f04380c did, on SuperProcure and on GoComet');
{
  let compared = 0, differ = 0, first = null;
  for (let k = 0; k < 300; k++) {
    const customers = names.slice(0, 1 + rnd(names.length)).map((label, i) => ({
      customerId: `c${i}`, label, aliases: [label], enabled: rnd(6) !== 0, margin: rnd(3) ? band() : null }));
    const assignments = [];
    for (let j = rnd(4); j > 0; j--) {
      assignments.push({ assignmentId: `a${k}-${j}`, customerId: `c${rnd(customers.length)}`, personId: 'p1',
        enabled: rnd(5) !== 0, updatedAt: rnd(1000), marginOverride: rnd(2) ? band() : null });
    }
    for (const companyName of names.concat(['Unknown Shipper Pvt Ltd'])) {
      for (const platformKey of ['sp', 'gocomet']) {
        const now = resolveMargin({ platformKey, companyName, customers, assignments, defaults });
        const then = resolveMarginF04380c({ platformKey, companyName, customers, assignments, defaults });
        compared++;
        if (JSON.stringify(now) !== JSON.stringify(then)) { differ++; if (!first) first = `${platformKey} ${companyName}: ${JSON.stringify(now)} vs ${JSON.stringify(then)}`; }
      }
    }
  }
  ok(differ === 0, `${compared} resolutions compared, ${differ} differ${first ? ` (first: ${first})` : ''}`);
}

console.log('\n2. a GoComet band of its own is what a GoComet load bids; SuperProcure keeps the customer band');
{
  const customers = [{ customerId: 'havells', label: 'Havells', aliases: ['Havells'], enabled: true,
    margin: { marginsPct: [9, 6, 4], minMarginPct: 4 },
    marginByPlatform: { gocomet: { marginsPct: [14, 11], minMarginPct: 11 } } }];
  const gc = resolveMargin({ platformKey: 'gocomet', companyName: 'Havells India Ltd', customers, assignments: [], defaults });
  ok(gc.marginsPct.join() === '14,11' && gc.minMarginPct === 11,
    `GoComet load -> the GoComet band (got ${gc.marginsPct} min ${gc.minMarginPct})`);
  ok(String(gc.source).indexOf('customer:havells') === 0,
    `its source still reads as this customer's margins (got ${gc.source})`);
  const sp = resolveMargin({ platformKey: 'sp', companyName: 'Havells India Ltd', customers, assignments: [], defaults });
  ok(sp.marginsPct.join() === '9,6,4' && sp.minMarginPct === 4 && sp.source === 'customer:havells',
    `SuperProcure load -> the customer band, as before (got ${sp.marginsPct} ${sp.source})`);
  const assignments = [{ assignmentId: 'a1', customerId: 'havells', personId: 'p1', enabled: true, marginOverride: { marginsPct: [8, 5], minMarginPct: 5 } }];
  const gcOv = resolveMargin({ platformKey: 'gocomet', companyName: 'Havells', customers, assignments, defaults });
  // Named reversal, owner default for C055: the tier order stays bid override > assignment override >
  // customer band > default, and the platform dimension lives only inside the customer-band tier. This
  // check used to assert the GoComet band outranked an assignment override.
  ok(gcOv.source === 'assignment:a1' && gcOv.marginsPct.join() === '8,5',
    `an assignment override still outranks the GoComet band (got ${gcOv.marginsPct} ${gcOv.source})`);
  const spOv = resolveMargin({ platformKey: 'sp', companyName: 'Havells', customers, assignments, defaults });
  ok(spOv.source === 'assignment:a1', `while SuperProcure still takes that override (got ${spOv.source})`);
}

console.log('\n3. the band is validated like every other band');
{
  const base = { customerId: 'havells', label: 'Havells', margin: { marginsPct: [9, 6, 4], minMarginPct: 4 } };
  const without = validateCustomer(base);
  ok(!Object.prototype.hasOwnProperty.call(without, 'marginByPlatform'), 'a customer without one stores no such key (byte-identical doc)');
  const withGc = validateCustomer(Object.assign({}, base, { marginByPlatform: { gocomet: { marginsPct: ['14', 11], minMarginPct: '11' } } }));
  ok(withGc.marginByPlatform && withGc.marginByPlatform.gocomet.marginsPct.join() === '14,11' && withGc.marginByPlatform.gocomet.minMarginPct === 11,
    'a valid GoComet band is stored, numbers coerced like the customer band');
  let err = null;
  try { validateCustomer(Object.assign({}, base, { marginByPlatform: { gocomet: { marginsPct: [14, 11], minMarginPct: 0 } } })); } catch (e) { err = e; }
  ok(!!err && err.code === 'BAD_INPUT', `a 0% GoComet minimum is refused like any other band (${err && err.message})`);
  err = null;
  try { validateCustomer(Object.assign({}, base, { marginByPlatform: { gocomet: { minMarginPct: 5 } } })); } catch (e) { err = e; }
  ok(!!err && err.code === 'BAD_INPUT', `a GoComet band with no rungs is refused (${err && err.message})`);
}

(async () => {
  console.log('\n4. a GoComet price request snapshots the GoComet band; an SP one the customer band');
  {
    const store = new MemoryStore();
    const customers = [validateCustomer({ customerId: 'havells', label: 'Havells', margin: { marginsPct: [9, 6, 4], minMarginPct: 4 },
      marginByPlatform: { gocomet: { marginsPct: [14, 11], minMarginPct: 11 } } })];
    const requests = new PriceRequestStore({ store, marginsPct: defaults.marginsPct, minMarginPct: defaults.minMarginPct,
      customersProvider: { list: async () => customers } });
    const load = (id) => ({ id, lane: { origin: 'Pune', destination: 'Delhi' }, companyName: 'Havells', closesAt: Date.now() + 3_600_000, units: 1 });
    const g = await requests.createForLoad(load('GC-ENQ-1'), { platformKey: 'gocomet' });
    const s = await requests.createForLoad(load('900111'), { platformKey: 'sp' });
    ok(g.marginsPct.join() === '14,11' && g.minMarginPct === 11, `GoComet request band ${g.marginsPct}`);
    ok(s.marginsPct.join() === '9,6,4' && s.minMarginPct === 4, `SuperProcure request band ${s.marginsPct}`);
  }

  console.log('\n5. a console customer save that does not send the GoComet band keeps it');
  {
    const { app, customerStore } = require('../src/web/server');
    await customerStore.upsert({ customerId: 'kingspan', label: 'Kingspan', margin: { marginsPct: [9, 6], minMarginPct: 6 },
      marginByPlatform: { gocomet: { marginsPct: [15, 12], minMarginPct: 12 } } });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    const body = JSON.stringify({ customerId: 'kingspan', label: 'Kingspan', aliases: ['Kingspan'],
      margin: { marginsPct: [10, 6], minMarginPct: 6 }, auction: null, enabled: true });
    const res = await new Promise((resolve, reject) => {
      const r = http.request({ hostname: '127.0.0.1', port, path: '/api/customers', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` } },
      (resp) => { let b = ''; resp.on('data', (d) => (b += d)); resp.on('end', () => resolve({ status: resp.statusCode, text: b })); });
      r.on('error', reject); r.write(body); r.end();
    });
    server.close();
    const after = await customerStore.get('kingspan');
    ok(res.status === 200 && after.margin.marginsPct.join() === '10,6', `the save lands (HTTP ${res.status}, band ${after && after.margin && after.margin.marginsPct})`);
    ok(!!after.marginByPlatform && after.marginByPlatform.gocomet.marginsPct.join() === '15,12',
      `and the GoComet band it did not send is kept (got ${JSON.stringify(after.marginByPlatform)})`);
  }

  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
