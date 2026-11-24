'use strict';
/**
 * Regression for the hard-close-only scope gate (Module 1 must never bid a soft-close /
 * anti-snipe auction while "Hard-close loads only" is set). Locks in the FAIL-CLOSED fix:
 *   A. isOutOfHardCloseScope holds OUT soft-close AND unverified-close-model loads; only a
 *      positively-confirmed hard close (softClose false + closeModelKnown true) is in scope.
 *   B. discovery.matchesAllowlist with hardCloseOnly excludes soft + unknown, admits confirmed
 *      hard, and (backward-compat) still admits an older snapshot that predates closeModelKnown.
 *   C. realAdapter._mapLoad classifies the close model from branchAuctionExtendTime and marks
 *      an absent/garbage value as unknown (closeModelKnown false), NOT silently hard.
 *
 *   node scripts/test-hardclose-scope.js
 */
const assert = require('assert');
const { DiscoveryPoller, isOutOfHardCloseScope } = require('../src/discovery/discovery');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { deriveLoadRules } = require('../src/model/loadRules');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// A. the shared predicate: fail closed on soft AND on unverified close model
assert.strictEqual(isOutOfHardCloseScope({ softClose: true, closeModelKnown: true }), true, 'soft-close is out of scope');
assert.strictEqual(isOutOfHardCloseScope({ softClose: false, closeModelKnown: false }), true, 'unverified close model is out of scope (fail closed)');
assert.strictEqual(isOutOfHardCloseScope({ softClose: false, closeModelKnown: true }), false, 'confirmed hard close is in scope');
assert.strictEqual(isOutOfHardCloseScope({ softClose: false }), false, 'legacy snapshot (no closeModelKnown) keeps prior behaviour');
ok('isOutOfHardCloseScope: soft + unverified out, confirmed hard in, legacy unchanged');

// B. matchesAllowlist with hardCloseOnly on
{
  // shippers is an explicit ['Syngenta'] (matching base.companyName) so the shipper filter always
  // passes and the ONLY variable under test is the hard-close gate. (An empty shippers list now
  // fails closed - see test-allowlist-and-prune.js Bug 3 - so it can no longer stand in for "no
  // shipper filter" here.)
  const poller = new DiscoveryPoller({ adapter: {}, requests: {}, notifier: {},
    config: { allowlist: { shippers: ['Syngenta'], lanes: [], hardCloseOnly: true } } });
  const base = { companyName: 'Syngenta', lane: { origin: 'A', destination: 'B' } };
  assert.strictEqual(poller.matchesAllowlist({ ...base, softClose: false, closeModelKnown: true }), true,
    'confirmed hard-close load passes the filter');
  assert.strictEqual(poller.matchesAllowlist({ ...base, softClose: true, closeModelKnown: true }), false,
    'soft-close load is excluded');
  assert.strictEqual(poller.matchesAllowlist({ ...base, softClose: false, closeModelKnown: false }), false,
    'unverified-close-model load is excluded (fail closed), not admitted as hard');
  ok('matchesAllowlist(hardCloseOnly): excludes soft + unverified, admits confirmed hard');

  // and with hardCloseOnly OFF, the same soft / unknown loads are admitted (the toggle is the gate)
  const off = new DiscoveryPoller({ adapter: {}, requests: {}, notifier: {},
    config: { allowlist: { shippers: ['Syngenta'], lanes: [], hardCloseOnly: false } } });
  assert.strictEqual(off.matchesAllowlist({ ...base, softClose: true, closeModelKnown: true }), true,
    'with the box off, soft-close loads are admitted');
  ok('matchesAllowlist(hardCloseOnly off): soft-close loads are admitted');
}

// C. _mapLoad close-model classification (the fail-open source)
{
  const a = new RealSuperProcureAdapter({ token: 'FAKE.TEST.TOKEN' });
  const future = new Date(Date.now() + 600000).toISOString();
  const map = (ext) => a._mapLoad({ id: 1, biddingCloseTime: future, branchAuctionExtendTime: ext });

  let m = map('00:00:00');
  assert.strictEqual(m.softClose, false); assert.strictEqual(m.closeModelKnown, true);
  ok('_mapLoad "00:00:00" -> confirmed hard (softClose false, closeModelKnown true)');

  m = map('00:05:00');
  assert.strictEqual(m.softClose, true); assert.strictEqual(m.closeModelKnown, true);
  ok('_mapLoad "00:05:00" -> confirmed soft (softClose true, closeModelKnown true)');

  for (const ext of [undefined, null, '', 'n/a', 300]) {
    m = map(ext);
    assert.strictEqual(m.softClose, false, `softClose false for ${JSON.stringify(ext)}`);
    assert.strictEqual(m.closeModelKnown, false, `closeModelKnown false (unknown) for ${JSON.stringify(ext)}`);
  }
  ok('_mapLoad absent/garbage extend time -> unknown (closeModelKnown false), NOT silently hard');
}

// D. the branchExtendAuction BOOLEAN is a liar - close model is derived from the TIME field ONLY.
// v4 full-board capture (2026-07-17, automated-bidding/_research/data/2026-07-17_v4-load-shapes-capture.md
// finding 3) proved the flag disagrees with the truth on 3 of 12 live branch configs, twice in the
// DANGEROUS direction (a soft branch whose flag reads 0/"hard" would be admitted into hard-close scope
// if the flag were trusted). The code reads branchAuctionExtendTime and never the boolean; pin that.
{
  const a = new RealSuperProcureAdapter({ token: 'FAKE.TEST.TOKEN' });
  const future = new Date(Date.now() + 600000).toISOString();
  // real captured shapes (companyName | extendTime | branchExtendAuction | truth):
  const shapes = [
    { name: 'Ashirvad-soft', branchAuctionExtendTime: '00:01:00', branchExtendAuction: 0, expectSoft: true },  // flag lies "hard" (dangerous)
    { name: 'Safex',         branchAuctionExtendTime: '00:02:00', branchExtendAuction: 0, expectSoft: true },  // flag lies "hard" (dangerous)
    { name: 'Havells-hard',  branchAuctionExtendTime: '00:00:00', branchExtendAuction: 1, expectSoft: false }, // flag lies "soft"
    { name: 'Rajratan',      branchAuctionExtendTime: '00:01:00', branchExtendAuction: 1, expectSoft: true },  // flag agrees
  ];
  for (const s of shapes) {
    const raw = { id: 1, companyName: s.name, biddingCloseTime: future,
      branchAuctionExtendTime: s.branchAuctionExtendTime, branchExtendAuction: s.branchExtendAuction };
    const m = a._mapLoad(raw);
    assert.strictEqual(m.softClose, s.expectSoft, `${s.name}: _mapLoad softClose follows the time field, not flag ${s.branchExtendAuction}`);
    assert.strictEqual(m.closeModelKnown, true, `${s.name}: parseable time -> close model known`);
    // the LoadRules derivation (the other close-model site) must agree with _mapLoad.
    assert.strictEqual(deriveLoadRules(raw).softClose, s.expectSoft, `${s.name}: deriveLoadRules softClose agrees, flag ignored`);
  }
  // the decisive invariant: for a FIXED extend time, softClose is INVARIANT to the boolean (proves it is
  // never read). Flip only the flag and assert the classification does not move.
  const mk = (flag) => a._mapLoad({ id: 2, biddingCloseTime: future, branchAuctionExtendTime: '00:01:00', branchExtendAuction: flag });
  assert.strictEqual(mk(0).softClose, mk(1).softClose, 'softClose is invariant to branchExtendAuction (flag never consulted)');
  assert.strictEqual(mk(0).softClose, true, 'the fixed 00:01:00 stays soft under either flag value');
  ok('_mapLoad + deriveLoadRules classify close model from branchAuctionExtendTime ONLY - the branchExtendAuction boolean is never read');
}

console.log(`\n${pass}/7 checks passed`);
process.exit(0);
