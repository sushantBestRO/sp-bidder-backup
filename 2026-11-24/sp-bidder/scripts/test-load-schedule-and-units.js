'use strict';
/**
 * Regression for the 2026-07-11 incident: SuperProcure returns a shared placeholder
 * biddingCloseTime/biddingStartTime ("2100-05-24T19:53:25.000Z"/"...19:38:25.000Z", to the
 * exact second) for any load whose biddingOn flag is 0 - not null, a real-looking but ~74-
 * years-out date. 44 of 105 live price requests carried this placeholder; 6 were already
 * armed with a real human-entered cost and never placed a single bid, because the engine
 * believed it had 74 years of runway. _mapLoad had never read biddingOn at all.
 *
 * Also covers two adjacent, same-session findings captured on the load snapshot:
 *   - weightUnit (SuperProcure's brancheUnit): several branches (Ashirvad Pipes, Tata
 *     Consumer) are configured in KG, not the assumed-everywhere MT. Verified live against
 *     SuperProcure's own weightUtilizationPercentage (weight / truck capacity) - only checks
 *     out when KG is honored.
 *   - distanceKm (SuperProcure's loadDistance): never captured before at all.
 *
 *   node scripts/test-load-schedule-and-units.js
 */
const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const a = new RealSuperProcureAdapter({ token: 'FAKE.TEST.TOKEN' });

// A. biddingOn: 0 -> the placeholder date is never trusted, regardless of how real it looks.
// This is the literal raw shape SuperProcure returned for load 22724361 (Ashirvad Pipes).
{
  const m = a._mapLoad({
    id: 22724361, companyName: 'Ashirvad Pipes Pvt Ltd', biddingOn: 0,
    biddingCloseTime: '2100-05-24T19:53:25.000Z', biddingStartTime: '2100-05-24T19:38:25.000Z',
    branchAuctionExtendTime: '00:00:00',
  });
  assert.strictEqual(m.closesAt, null, 'biddingOn:0 -> closesAt null, even though biddingCloseTime parses fine');
  assert.strictEqual(m.startsAt, null, 'biddingOn:0 -> startsAt null');
  assert.strictEqual(m.status, 'unscheduled', 'biddingOn:0 -> status is unscheduled, not scheduled/live/closed');
  assert.strictEqual(m.biddingOn, false, 'biddingOn surfaced on the mapped load for downstream checks');
  ok('_mapLoad: biddingOn:0 nulls out closesAt/startsAt and marks the load unscheduled, reproducing the exact 22724361 incident');
}

// B. biddingOn: 1 with a real near-term date -> closesAt/startsAt populate normally (the
// happy path this app has always relied on - must keep working).
{
  const now = Date.now();
  const close = new Date(now + 20 * 60000).toISOString();
  const start = new Date(now - 5 * 60000).toISOString();
  const m = a._mapLoad({ id: 1, biddingOn: 1, biddingCloseTime: close, biddingStartTime: start, branchAuctionExtendTime: '00:00:00' });
  assert.ok(m.closesAt && Math.abs(m.closesAt - Date.parse(close)) < 1000, 'biddingOn:1 -> closesAt parses the real close time');
  assert.strictEqual(m.status, 'live', 'biddingOn:1, started, not yet closed -> status live');
  ok('_mapLoad: biddingOn:1 with a real date -> closesAt/startsAt populate, status derives normally (happy path unaffected)');
}

// C. biddingOn: 1 but the date itself is garbage/out-of-window - defense in depth for a
// DIFFERENT bad-date shape than the biddingOn:0 case (e.g. a scheduled load with a typo'd
// year). Bound is generous (+/-30 days) so it never rejects a real near-boundary load.
{
  const now = Date.now();
  const wayOut = new Date(now + 400 * 86400000).toISOString(); // over a year out
  const m = a._mapLoad({ id: 2, biddingOn: 1, biddingCloseTime: wayOut, branchAuctionExtendTime: '00:00:00' });
  assert.strictEqual(m.closesAt, null, 'biddingOn:1 but the parsed date is far outside the sane window -> rejected too');
  ok('_mapLoad: even a biddingOn:1 load gets its close time bound-checked, not just NaN-checked');

  const nearBoundary = new Date(now + 13 * 86400000).toISOString(); // inside the app's own 14-day query window
  const m2 = a._mapLoad({ id: 3, biddingOn: 1, biddingCloseTime: nearBoundary, branchAuctionExtendTime: '00:00:00' });
  assert.ok(m2.closesAt != null, 'a real load close to the window edge is NOT falsely rejected');
  ok('_mapLoad: a legitimate near-boundary close time survives the bound check (no false rejection)');
}

// D. weightUnit passthrough - the actual 2026-07-11 incident data (verified live against
// SuperProcure's own weightUtilizationPercentage: 4400 KG / 6000 KG capacity = 73.33%,
// matching what SuperProcure itself reported for this exact load).
{
  const m = a._mapLoad({ id: 23062480, companyName: 'Ashirvad Pipes Pvt Ltd', weight: 4400, brancheUnit: 'KG', vehicleName: '22FT-SA-6MT (Container)' });
  assert.strictEqual(m.weightUnit, 'KG', 'brancheUnit carried through as weightUnit, not assumed MT');
  assert.strictEqual(m.weight, 4400, 'the raw weight number is untouched - only the unit label was ever wrong');
  const noUnit = a._mapLoad({ id: 5, weight: 6, branchAuctionExtendTime: '00:00:00' });
  assert.strictEqual(noUnit.weightUnit, null, 'absent brancheUnit -> weightUnit null (display layer defaults to MT, not this layer)');
  ok('_mapLoad: weightUnit reads SuperProcure\'s own brancheUnit instead of the adapter silently assuming MT');
}

// E. distanceKm - never captured before this fix.
{
  const m = a._mapLoad({ id: 22724361, loadDistance: 235.58, branchAuctionExtendTime: '00:00:00' });
  assert.strictEqual(m.distanceKm, 235.58, 'loadDistance carried through as distanceKm');
  const noDist = a._mapLoad({ id: 6, branchAuctionExtendTime: '00:00:00' });
  assert.strictEqual(noDist.distanceKm, null, 'absent loadDistance -> distanceKm null, not 0 or undefined');
  ok('_mapLoad: distanceKm captured from loadDistance (previously dropped entirely, flagged missing by Suyashh)');
}

// F. biddingOn: 0 with a REAL FUTURE window - SuperProcure's "Auction starts at ..." state.
// biddingOn stays 0 until SP opens the window, so gating on it alone (case A's first cut)
// also nulled genuinely scheduled auctions - the pricing team lost all lead time and the
// arm-lead wake found no known close (class-C premature finalize, OA 23088404/23088465,
// 2026-07-13). The real-times-vs-placeholder distinction is what separates this from A.
{
  const now = Date.now();
  const start = new Date(now + 25 * 60000).toISOString();
  const close = new Date(now + 55 * 60000).toISOString();
  const m = a._mapLoad({ id: 23088404, companyName: 'Renewsys India', biddingOn: 0,
    biddingStartTime: start, biddingCloseTime: close, branchAuctionExtendTime: '00:00:00' });
  assert.strictEqual(m.status, 'scheduled', 'biddingOn:0 + real future window -> scheduled, not unscheduled');
  assert.ok(m.closesAt && Math.abs(m.closesAt - Date.parse(close)) < 1000, 'real future close time is KEPT');
  assert.ok(m.startsAt && Math.abs(m.startsAt - Date.parse(start)) < 1000, 'real future start time is KEPT');
  ok('_mapLoad: biddingOn:0 with a real future window is scheduled-with-times (the "Auction starts at" state)');
}

// G. biddingOn: 0 fail-closed edges - anything NOT a verifiable future window stays unscheduled.
{
  const now = Date.now();
  // window already in the past (stale/odd payload) -> distrust
  const past = a._mapLoad({ id: 7, biddingOn: 0,
    biddingStartTime: new Date(now - 60 * 60000).toISOString(),
    biddingCloseTime: new Date(now - 30 * 60000).toISOString(), branchAuctionExtendTime: '00:00:00' });
  assert.strictEqual(past.status, 'unscheduled', 'biddingOn:0 + past window -> unscheduled (fail closed)');
  assert.strictEqual(past.closesAt, null, 'past-window times are nulled');
  // start without close (partial data) -> distrust
  const partial = a._mapLoad({ id: 8, biddingOn: 0,
    biddingStartTime: new Date(now + 10 * 60000).toISOString(), branchAuctionExtendTime: '00:00:00' });
  assert.strictEqual(partial.status, 'unscheduled', 'biddingOn:0 + partial window -> unscheduled (fail closed)');
  // window open NOW but biddingOn still 0 (SP lag or early close) -> distrust; the next
  // discovery tick catches the biddingOn:1 flip within seconds if it is real
  const openNow = a._mapLoad({ id: 9, biddingOn: 0,
    biddingStartTime: new Date(now - 5 * 60000).toISOString(),
    biddingCloseTime: new Date(now + 25 * 60000).toISOString(), branchAuctionExtendTime: '00:00:00' });
  assert.strictEqual(openNow.status, 'unscheduled', 'biddingOn:0 + already-open window -> unscheduled (biddingOn owns the live state)');
  ok('_mapLoad: biddingOn:0 stays unscheduled unless the window is verifiably in the future (placeholder/past/partial/open all fail closed)');
}

console.log(`\n${pass}/8 checks passed`);
process.exit(0);
