'use strict';
/**
 * Pins C056/D050 (fix/ops-alerting-divergences).
 *
 * config.softClose.shippers is a GLOBAL soft-close enrolment list, and matchesAllowlist checked it
 * FIRST, ahead of any hard-allowlist exclusion - so a shipper enrolled for the SuperProcure soft
 * endgame was admitted on EVERY account where it verified soft, even one whose own hard allowlist
 * deliberately did not name that shipper (including the explicit ["__none__"] opt-out sentinel).
 * Global soft-close enrolment must only ever SELECT STRATEGY for an already-admitted load, never
 * ADMIT a load the account's own allowlist rejects.
 *
 * The owner's rule, pinned as three cases:
 *   1. empty/absent hard allowlist + soft-enrolled shipper -> admitted (today's behaviour, kept);
 *   2. non-empty hard allowlist matching the shipper (soft-enrolled or not) -> admitted;
 *   3. non-empty hard allowlist NOT matching the shipper (or the ["__none__"] sentinel), even
 *      soft-enrolled -> REJECTED. This is the fix.
 *
 * @requires-summary-line
 *   node scripts/test-c056-d050-hard-allowlist-gates-soft-admission.js
 */
const assert = require('assert');
const { DiscoveryPoller } = require('../src/discovery/discovery');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const softLoad = (companyName) => ({
  companyName, lane: { origin: 'A', destination: 'B' },
  softClose: true, closeModelKnown: true,
});

const mkPoller = (allowlistShippers) => new DiscoveryPoller({
  adapter: {}, requests: {}, notifier: {},
  config: {
    allowlist: { shippers: allowlistShippers },
    softClose: { enabled: true, shippers: ['Dynamic Cables'] },
  },
});

(async () => {
  // ---- case 1: empty/absent hard allowlist + soft-enrolled shipper -> admitted (kept) ----
  {
    const p1 = mkPoller([]);
    assert.strictEqual(p1.matchesAllowlist(softLoad('Dynamic Cables')), true,
      'case 1: an empty hard allowlist still admits a soft-enrolled shipper (today\'s behaviour)');
    const p1b = mkPoller(undefined);
    assert.strictEqual(p1b.matchesAllowlist(softLoad('Dynamic Cables')), true,
      'case 1b: an absent hard allowlist (no shippers key at all) also admits a soft-enrolled shipper');
    ok('case 1: empty/absent hard allowlist + soft-enrolled shipper is admitted');
  }

  // ---- case 2: non-empty hard allowlist matching the shipper -> admitted ----
  {
    const p2 = mkPoller(['Dynamic Cables']);
    assert.strictEqual(p2.matchesAllowlist(softLoad('Dynamic Cables')), true,
      'case 2: a non-empty hard allowlist that names the shipper still admits it (soft-enrolled)');
    const p2b = mkPoller(['Havells']); // matches on a DIFFERENT shipper than the soft-enrolled one
    assert.strictEqual(p2b.matchesAllowlist({ companyName: 'Havells', lane: { origin: 'A', destination: 'B' } }), true,
      'control: a plain hard-list match with no soft-close involvement is unaffected');
    ok('case 2: a non-empty hard allowlist matching the shipper is admitted');
  }

  // ---- case 3 (the fix): non-empty hard allowlist NOT matching -> rejected, even soft-enrolled ----
  {
    const p3 = mkPoller(['Havells']); // does not include Dynamic Cables
    assert.strictEqual(p3.matchesAllowlist(softLoad('Dynamic Cables')), false,
      'C056/D050: a non-empty hard allowlist that excludes the shipper rejects it, even though it is soft-enrolled');
    ok('case 3a: a non-empty hard allowlist excluding the shipper rejects it despite soft enrolment');
  }
  {
    const p3none = mkPoller(['__none__']); // the explicit opt-out sentinel
    assert.strictEqual(p3none.matchesAllowlist(softLoad('Dynamic Cables')), false,
      'C056/D050: the ["__none__"] sentinel rejects a soft-enrolled shipper too - an explicit opt-out must hold');
    ok('case 3b: the ["__none__"] sentinel rejects a soft-enrolled shipper');
  }

  // ---- control: a non-soft-enrolled shipper is unaffected by any of this ----
  {
    const p = mkPoller(['Havells']);
    assert.strictEqual(p.matchesAllowlist({ companyName: 'RandomCo', lane: { origin: 'A', destination: 'B' } }), false,
      'control: an unrelated, non-enrolled shipper is still rejected by a non-matching hard list');
    ok('control: an ordinary non-enrolled, non-matching shipper is unaffected');
  }

  console.log(`\n${pass}/5 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
