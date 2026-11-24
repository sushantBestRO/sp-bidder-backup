'use strict';
/**
 * MARGIN RESOLUTION IS TOTAL: A MALFORMED BAND DOCUMENT NEVER THROWS, AND NEVER BLOCKS THE SHIPPER.
 *
 * Regression target: A012. resolveMargin called `.marginsPct.slice()` on the assignment override and
 * on the customer margin unguarded, so a hand-edited customers.json carrying {minMarginPct: 5} and no
 * rung list threw "Cannot read properties of undefined (reading 'slice')" - inside the /price revert
 * gate, and on the create path, where every new price request for that shipper then failed.
 *
 * Now a tier whose band has no rung list is passed over and the next tier resolves: a malformed
 * assignment override falls to the customer band, a malformed customer band falls to the default.
 * Well-formed documents resolve exactly as before.
 *
 *   node scripts/test-resolve-margin-total.js
 */
const { resolveMargin } = require('../src/model/resolve');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { MemoryStore } = require('../src/store/memoryStore');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };
const defaults = { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 };
const acme = (margin) => ({ customerId: 'acme', label: 'Acme', aliases: ['Acme'], enabled: true, margin });
const tryResolve = (args) => { try { return { r: resolveMargin(args) }; } catch (e) { return { err: e }; } };

(async () => {
  {
    const { r, err } = tryResolve({ platformKey: 'sp', companyName: 'Acme Ltd', customers: [acme({ minMarginPct: 5 })], assignments: [], defaults });
    ok(!err, `a customer band with no rung list does not throw (${err ? err.message : 'no throw'})`);
    ok(!!r && r.source === 'default' && r.marginsPct.join() === '12.6,7.2,6.3' && r.minMarginPct === 6.3,
      `and the load resolves to the next tier, the default band (got ${r && r.source} ${r && r.marginsPct})`);
  }
  {
    const customers = [acme({ marginsPct: [10, 8], minMarginPct: 8 })];
    const assignments = [{ assignmentId: 'a1', customerId: 'acme', personId: 'p1', enabled: true, marginOverride: { minMarginPct: 4 } }];
    const { r, err } = tryResolve({ platformKey: 'sp', companyName: 'Acme', customers, assignments, defaults });
    ok(!err, `an assignment override with no rung list does not throw (${err ? err.message : 'no throw'})`);
    ok(!!r && r.source === 'customer:acme' && r.marginsPct.join() === '10,8',
      `and the load resolves to the customer band beneath it (got ${r && r.source})`);
  }
  {
    const customers = [acme({ marginsPct: [10, 8], minMarginPct: 8 })];
    const assignments = [{ assignmentId: 'a1', customerId: 'acme', personId: 'p1', enabled: true, marginOverride: { marginsPct: [9, 7], minMarginPct: 7 } }];
    const r = resolveMargin({ platformKey: 'sp', companyName: 'Acme', customers, assignments, defaults });
    ok(r.source === 'assignment:a1' && r.marginsPct.join() === '9,7' && r.minMarginPct === 7,
      'a well-formed assignment override still wins, unchanged');
    const c = resolveMargin({ platformKey: 'sp', companyName: 'Acme', customers, assignments: [], defaults });
    ok(c.source === 'customer:acme' && c.marginsPct.join() === '10,8' && c.minMarginPct === 8,
      'a well-formed customer band still resolves, unchanged');
  }
  {
    const store = new MemoryStore();
    const customersProvider = { list: async () => [acme({ minMarginPct: 5 })] };
    const requests = new PriceRequestStore({ store, marginsPct: defaults.marginsPct, minMarginPct: defaults.minMarginPct, customersProvider });
    let created = null, err = null;
    try {
      created = await requests.createForLoad({ id: 'L-A012', lane: { origin: 'Pune', destination: 'Delhi' }, companyName: 'Acme',
        closesAt: Date.now() + 3_600_000, units: 1 });
    } catch (e) { err = e; }
    ok(!err && !!created && created.status === 'awaiting_price',
      `a new load for that shipper still gets its price request (${err ? err.message : created && created.status})`);
    let minimum = null; err = null;
    try { minimum = await requests.customerMinimumFor({ platformKey: 'sp', load: { companyName: 'Acme' } }); } catch (e) { err = e; }
    ok(!err && minimum === 6.3, `and the page's customer-minimum read answers instead of throwing (${err ? err.message : minimum})`);
  }

  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
