'use strict';
/**
 * Customer + bid-level margin overrides. Covers the resolver precedence, the profile
 * store CRUD/validation, and the price-request wiring (createForLoad resolves the
 * customer band; capture + setBidOverride apply a per-load override). The cost-floor
 * invariant is unaffected and covered by test-operating-floor.js / test-cost-floor-guard.js.
 */
const assert = require('assert');
const { createStore } = require('../src/store');
const { resolveBand } = require('../src/pricing/marginResolver');
const { MarginProfileStore, slugifyCustomer } = require('../src/pricing/marginProfiles');
const { PriceRequestStore } = require('../src/pricing/priceRequests');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };
const DEFAULTS = { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 };

// ---- resolver precedence + tie-break ----------------------------------------
{
  const profs = [
    { platformKey: 'sp', customerKey: 'syngenta', customerLabel: 'Syngenta', marginsPct: [14, 9, 7], minMarginPct: 7, enabled: true },
  ];
  const hit = resolveBand({ platformKey: 'sp', companyName: 'Syngenta India Ltd', profiles: profs, defaults: DEFAULTS });
  ok(hit.source === 'customer:syngenta', `word-prefix customer match -> customer source, got ${hit.source}`);
  ok(JSON.stringify(hit.marginsPct) === JSON.stringify([14, 9, 7]), `customer band applied, got ${JSON.stringify(hit.marginsPct)}`);

  const miss = resolveBand({ platformKey: 'sp', companyName: 'Renewsys India', profiles: profs, defaults: DEFAULTS });
  ok(miss.source === 'default' && JSON.stringify(miss.marginsPct) === JSON.stringify(DEFAULTS.marginsPct), 'no match -> default band');

  // platform scoping: an 'sp' profile must NOT apply to a gocomet load
  const wrongPlatform = resolveBand({ platformKey: 'gocomet', companyName: 'Syngenta India Ltd', profiles: profs, defaults: DEFAULTS });
  ok(wrongPlatform.source === 'default', `profile for another portal never applies, got ${wrongPlatform.source}`);

  // word-boundary: "Ren" must not sweep in "Warren Steel"
  const boundary = resolveBand({ platformKey: 'sp', companyName: 'Warren Steel',
    profiles: [{ platformKey: 'sp', customerKey: 'ren', customerLabel: 'Ren', marginsPct: [10], minMarginPct: 5, enabled: true }], defaults: DEFAULTS });
  ok(boundary.source === 'default', 'word-boundary: mid-word substring is not a match');

  // disabled profile is ignored
  const disabled = resolveBand({ platformKey: 'sp', companyName: 'Syngenta',
    profiles: [{ platformKey: 'sp', customerKey: 'syngenta', customerLabel: 'Syngenta', marginsPct: [20], minMarginPct: 9, enabled: false }], defaults: DEFAULTS });
  ok(disabled.source === 'default', 'disabled profile is ignored');

  // tie-break: exact label match beats a shorter word-prefix match
  const tie = resolveBand({ platformKey: 'sp', companyName: 'Tata Steel',
    profiles: [
      { platformKey: 'sp', customerKey: 'tata', customerLabel: 'Tata', marginsPct: [10], minMarginPct: 5, enabled: true },
      { platformKey: 'sp', customerKey: 'tata-steel', customerLabel: 'Tata Steel', marginsPct: [8], minMarginPct: 4, enabled: true },
    ], defaults: DEFAULTS });
  ok(tie.source === 'customer:tata-steel', `exact/longest match wins the tie, got ${tie.source}`);
}

// ---- profile store CRUD + validation ----------------------------------------
(async () => {
  const store = createStore({ backend: 'memory' });
  const profiles = new MarginProfileStore({ store });

  ok(slugifyCustomer('Tata Steel') === 'tata-steel', `slugify collapses to url-safe, got ${slugifyCustomer('Tata Steel')}`);

  const saved = await profiles.upsert({ platformKey: 'sp', customer: 'Syngenta', marginsPct: [14, 9, 7], minMarginPct: 7, updatedBy: 'tester' });
  ok(saved.customerKey === 'syngenta' && saved.customerLabel === 'Syngenta', 'upsert normalizes label -> key');
  ok((await profiles.list('sp')).length === 1, 'list returns the saved profile for the portal');
  ok((await profiles.list('gocomet')).length === 0, 'list is platform-scoped');
  ok((await profiles.get('sp', 'syngenta')).minMarginPct === 7, 'get returns the profile');

  let threw = false;
  try { await profiles.upsert({ platformKey: 'sp', customer: 'Bad', marginsPct: [], minMarginPct: 5 }); } catch (e) { threw = e.code === 'BAD_INPUT'; }
  ok(threw, 'upsert rejects an empty band (BAD_INPUT)');

  threw = false;
  try { await profiles.upsert({ platformKey: 'sp', customer: '', marginsPct: [10], minMarginPct: 5 }); } catch (e) { threw = e.code === 'BAD_INPUT'; }
  ok(threw, 'upsert rejects a blank customer name');

  ok((await profiles.remove('sp', 'syngenta')) === true, 'remove deletes the profile');
  ok((await profiles.list('sp')).length === 0, 'list is empty after remove');

  // ---- price-request wiring: customer resolution at createForLoad -------------
  await profiles.upsert({ platformKey: 'sp', customer: 'Syngenta', marginsPct: [14, 9, 7], minMarginPct: 7 });
  const requests = new PriceRequestStore({ store, marginsPct: DEFAULTS.marginsPct, minMarginPct: DEFAULTS.minMarginPct, profiles, platformKey: 'sp' });
  const now = Date.now();

  const rSyn = await requests.createForLoad({ id: 'L1', companyName: 'Syngenta India Ltd', closesAt: now + 600000 });
  ok(rSyn.marginSource === 'customer:syngenta' && JSON.stringify(rSyn.marginsPct) === JSON.stringify([14, 9, 7]), 'createForLoad snapshots the customer band');
  ok(rSyn.platformKey === 'sp', 'createForLoad stamps the platform');

  const rDef = await requests.createForLoad({ id: 'L2', companyName: 'Renewsys', closesAt: now + 600000 });
  ok(rDef.marginSource === 'default' && JSON.stringify(rDef.marginsPct) === JSON.stringify(DEFAULTS.marginsPct), 'createForLoad falls back to default');

  // capture WITHOUT override -> keeps the (customer) band
  const capSyn = await requests.capture(rSyn.id, { cost: 100000 });
  ok(capSyn.status === 'armed' && JSON.stringify(capSyn.price.marginsPct) === JSON.stringify([14, 9, 7]), 'capture keeps the inherited customer band');

  // capture WITH a bid-level override -> band + source flip to bid
  const capDef = await requests.capture(rDef.id, { cost: 50000, marginOverride: { marginsPct: [20, 12, 9], minMarginPct: 9 } });
  ok(capDef.marginSource === 'bid' && JSON.stringify(capDef.price.marginsPct) === JSON.stringify([20, 12, 9]), 'capture applies a bid-level override');
  ok(capDef.marginOverride && capDef.marginOverride.setBy === 'pricing', 'override records who set it');

  // bad override at capture -> BAD_INPUT, request stays awaiting (not silently armed)
  const rBad = await requests.createForLoad({ id: 'L3', companyName: 'Acme', closesAt: now + 600000 });
  let capThrew = false;
  try { await requests.capture(rBad.id, { cost: 50000, marginOverride: { marginsPct: [], minMarginPct: 5 } }); } catch (e) { capThrew = e.code === 'BAD_INPUT'; }
  ok(capThrew, 'capture rejects a malformed override');
  ok((await requests.getByToken(rBad.id)).status === 'awaiting_price', 'a rejected override leaves the request awaiting, not armed');

  // setBidOverride on an awaiting request, then clear reverts to the inherited (customer) band
  const rSet = await requests.createForLoad({ id: 'L4', companyName: 'Syngenta', closesAt: now + 600000 });
  const set = await requests.setBidOverride(rSet.id, { marginsPct: [18, 10], minMarginPct: 8 }, { setBy: 'operator' });
  ok(set.marginSource === 'bid' && JSON.stringify(set.marginsPct) === JSON.stringify([18, 10]), 'setBidOverride applies the override');
  const cleared = await requests.clearBidOverride(rSet.id);
  ok(cleared.marginSource === 'customer:syngenta' && JSON.stringify(cleared.marginsPct) === JSON.stringify([14, 9, 7]), 'clearBidOverride reverts to the inherited customer band');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
