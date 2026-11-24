'use strict';
/**
 * GoComet intake flow, driven against CAPTURED REAL RESPONSES rather than hand-built ones.
 *
 * scripts/test-gocomet-adapter.js already covers the adapter's behaviour using synthetic
 * enquiries. This file covers the one thing synthetic data structurally cannot: whether the
 * shapes the adapter reads are the shapes the portal actually sends. GoComet publishes no spec,
 * so a captured baseline is the only drift detector available (MULTI_PLATFORM_ARCHITECTURE.md,
 * "Integrating a portal with no specification").
 *
 * Fixtures: scripts/fixtures/gocomet/ - live enquiry 2608115VVB, 2026-08-11 ~10:40 IST. See the
 * README there for what was redacted.
 *
 * The path exercised is the whole intake question, end to end and offline:
 *   real spot list -> real enquiry detail -> _mapEnquiry -> DiscoveryPoller.matchesAllowlist
 *   -> real bidding-data -> getAuctionState
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { DiscoveryPoller, isOutOfHardCloseScope, softAdmitted } = require('../src/discovery/discovery');

const EXPECTED_CHECKS = 50;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const FIX = path.join(__dirname, 'fixtures', 'gocomet');
const readFix = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));

const LIST = readFix('spot-enquiries.list.json');
const DETAIL = readFix('enquiry-detail.json');
const BIDDING = readFix('bidding-data.json');

const KEY = '2608115VVB';
// The instant the fixtures were captured. Pinned because _boundedParseMs rejects a close time too
// far in the past - without this the whole file would start failing the moment the captured
// auction's 11:30 IST close went by, which would be a clock artefact and not a contract change.
const CAPTURED_AT = Date.parse('2026-08-11T05:10:00.000Z');

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.`
  + `${b64url({ exp: Math.floor(CAPTURED_AT / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' })}.sig`;

const resp = (status, body) => ({
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
});

/** Routes the three captured endpoints; anything else is a 404 so an unexpected call is visible. */
function fixtureFetch() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init && init.method });
    const u = String(url);
    if (u.includes(`/enquiries/${KEY}/bidding-data`)) return resp(200, BIDDING);
    if (u.includes(`/enquiries/${KEY}`)) return resp(200, DETAIL);
    if (u.includes('/enquiries/spot')) return resp(200, LIST);
    return resp(404, { error: 'no_route' });
  };
  return { calls, fetchImpl };
}

const makeAdapter = (f) => new GoCometAdapter({
  token: token(), fetchImpl: f.fetchImpl, sleep: async () => {}, now: () => CAPTURED_AT,
});

(async () => {
  // ---- 1. the captured wire still carries every field the adapter reads off it ----
  //
  // Asserting the KEY SET, not just that a parse succeeded. The drift that breaks an unspecified
  // integration is a field going away or going null, and neither throws.
  {
    ok(Array.isArray(LIST.enquiries) && LIST.enquiries.length === 1,
      'list fixture: one enquiry under `enquiries`');
    const e = LIST.enquiries[0];
    ok(e.key === KEY, 'list: `key` is the enquiry id the adapter uses as load id');
    ok(e.client_company_name === 'Waaree Energies Ltd.',
      'list: the shipper arrives as `client_company_name` (NOT `company_name`)');
    ok(e.bid_close_timestamp === '2026-08-11T11:30:00.000+05:30',
      'list: `bid_close_timestamp` is the ISO close with offset');
    ok(e.bidding_closed === false, 'list: `bidding_closed` present and false on an open enquiry');
    ok(e.show_cost_of_l1_quote === false, 'list: Waaree hides L1 (showsL1 source field is false)');
    ok(e.mode === 'FTL', 'list: `mode` carries the equipment class');

    // The detail-only trio. The whole reason _fetchEnquiryDetail exists is that these three are
    // absent from the list; assert BOTH halves so a portal that starts serving them on the list,
    // or stops serving them on the detail, is caught.
    for (const k of ['cargo_quantity', 'cargo_unit', 'slab_rate']) {
      ok(!(k in e), `list: \`${k}\` is still detail-only (absent from the list item)`);
      ok(DETAIL[k] != null, `detail: \`${k}\` present`);
    }
    ok(DETAIL.cargo_unit === 'TRUCK', 'detail: cargo_unit TRUCK - a basis this adapter can bid');
    ok(Number(DETAIL.slab_rate) === 300, 'detail: slab_rate 300 (per-enquiry, not a constant)');
  }

  // ---- 2. bidding-data returns exactly seven keys ----
  //
  // The ADR's census result, re-asserted against a fresh capture. It is what justifies refusing to
  // publish a field from this endpoint just because it appears in an adjacent allowlist.
  {
    const keys = Object.keys(BIDDING).sort();
    const censused = ['bid_close_time', 'bid_closing_in', 'bid_opening_in',
      'current_server_time', 'revisions_left', 'total_revisions', 'vendor_rank'];
    ok(keys.length === censused.length && keys.every((k, i) => k === censused[i]),
      `bidding-data: exactly the seven censused keys, no more and no fewer (got ${keys.join(',')})`);
    ok(!('bidding_closed' in BIDDING),
      'bidding-data: `bidding_closed` is still NOT on this endpoint');
    ok(!('slab_rate' in BIDDING),
      'bidding-data: `slab_rate` absent - the hot path can only have it from the cached detail');
  }

  // ---- 3. listAuctions maps the real wire into a domain load ----
  let load = null;
  {
    const f = fixtureFetch();
    const loads = await makeAdapter(f).listAuctions();
    ok(loads.length === 1, 'listAuctions: the real list yields one mapped load');
    load = loads[0];

    ok(load.id === KEY, 'mapped: id is the enquiry key');
    ok(load.companyName === 'Waaree Energies Ltd.',
      'mapped: companyName - the ONE key every consumer above the seam reads');
    ok(load.closesAt === Date.parse('2026-08-11T11:30:00.000+05:30'), 'mapped: closesAt parsed');
    ok(load.status === 'open', 'mapped: status open');
    ok(load.softClose === true && load.closeModelKnown === true,
      'mapped: the BOOLEAN PAIR is set - the only close-model vocabulary the scope gate reads');
    ok(load.quoteType === 'FTL', 'mapped: TRUCK basis published as quoteType FTL');
    ok(load.units === 1, 'mapped: units 1, from the detail enrichment');
    ok(load.minDecrement === 300, 'mapped: per-enquiry minDecrement from slab_rate');
    ok(load.showsL1 === false, 'mapped: showsL1 false (rank-only on Waaree)');
    ok(load.cargoLines === 1, 'mapped: one cargo descriptor -> one freight-charge line expected');

    // The enrichment actually cost a detail GET - the mapping above is not the unenriched
    // degradation path wearing the same shape.
    ok(f.calls.some((c) => c.url.includes(`/enquiries/${KEY}`) && !c.url.includes('bidding-data')),
      'listAuctions: the enquiry detail was really fetched (units/minDecrement are enriched)');
  }

  // ---- 4. THE INTAKE QUESTION: does this load reach the desk? ----
  //
  // The GoComet stack's real shape - GC_ALLOWLIST_SHIPPERS defaults to 'Waaree' (src/config.js)
  // and gocometStack.js pins hardCloseOnly FALSE, because every GoComet load is softClose:true and
  // a hard-close-only allowlist would surface nothing at all.
  {
    const poller = new DiscoveryPoller({
      adapter: {}, requests: {}, notifier: {}, platformKey: 'gocomet',
      config: { allowlist: { shippers: ['Waaree'], lanes: [], hardCloseOnly: false } },
    });
    ok(poller.matchesAllowlist(load) === true,
      'INTAKE: the real captured Waaree load is ADMITTED by the shipped GoComet allowlist');

    // "Waaree" matching "Waaree Energies Ltd." is a word-PREFIX match, not a substring accident.
    const other = Object.assign({}, load, { companyName: 'Some Other Shipper Ltd.' });
    ok(poller.matchesAllowlist(other) === false, 'INTAKE: a non-allowlisted shipper is refused');

    // hardCloseOnly is the switch that decides this, and it is worth pinning rather than trusting:
    // flip it and the same load disappears, with no error anywhere.
    ok(isOutOfHardCloseScope(load) === true,
      'the mapped load IS out of hard-close scope (it is a soft-close portal)');
    const hardPoller = new DiscoveryPoller({
      adapter: {}, requests: {}, notifier: {},
      config: { allowlist: { shippers: ['Waaree'], lanes: [], hardCloseOnly: true } },
    });
    ok(hardPoller.matchesAllowlist(load) === false,
      'INTAKE: hardCloseOnly:true would SILENTLY drop this load - gocometStack must keep it false');

    // The other admission route, for a deployment that scopes purely through the soft-close list.
    const softPoller = new DiscoveryPoller({
      adapter: {}, requests: {}, notifier: {},
      config: {
        allowlist: { shippers: [], lanes: [], hardCloseOnly: true },
        softClose: { enabled: true, shippers: ['Waaree'] },
      },
    });
    ok(softPoller.matchesAllowlist(load) === true,
      'INTAKE: soft-close enrolment admits the same load on a hard-close-only allowlist');
  }

  // ---- 5. getAuctionState off the real bidding-data ----
  {
    const f = fixtureFetch();
    const a = makeAdapter(f);
    await a.listAuctions();                 // seeds the detail cache, as discovery does
    const st = await a.getAuctionState(KEY);

    ok(st.ok === true, 'getAuctionState: real bidding-data reads ok');
    ok(st.status === 'live', 'state: live (bid_closing_in is a number, not null)');
    ok(st.closesInMs === Date.parse('2026-08-11T11:30:00.000+05:30') - Date.parse(BIDDING.current_server_time),
      `ruling 51: closesInMs is the PLATFORM countdown made exact - the posted 11:30 close minus the server stamp, `
      + `never the local clock (got ${st.closesInMs})`);
    ok(st.revisionsLeft === 3 && st.revisionLimit === 3,
      'state: the full 3-revision budget is intact on a fresh enquiry');
    ok(st.myRank === null, 'state: vendor_rank null before we have quoted');
    ok(st.standingL1Price === null, 'state: rank-only - no standing L1 price');
    ok(st.minDecrement === 300,
      'state: minDecrement served from the discovery-time detail cache, not re-read');

    // The known INERT mechanism, pinned per ADR invariant 8: the declaration must fail the day the
    // adapter starts publishing the field, rather than rotting into a lie.
    ok(st.triggerWindowMs === undefined,
      'state: triggerWindowMs still absent - the fire-above-the-anti-snipe-window band stays INERT');
  }

  // ---- 6. THE CAPTURE QUESTION: why this load needs the GoComet stack to own it ----
  //
  // Surfacing a load and being able to PRICE it are two gates, and this codebase has already
  // shipped them out of step once: discovery admitted an enrolled soft load and sent the link,
  // then POST /price refused the cost with OUT_OF_SCOPE and zero soft bids landed
  // (server.js:2542). The backstop is:
  //
  //   effectiveAl = (ownerStack && ownerStack.account.allowlist) || liveCfg.allowlist
  //   if (effectiveAl.hardCloseOnly)
  //     if (isOutOfHardCloseScope(load) && !softAdmitted(liveCfg.softClose, load)) -> 409
  //
  // Only the INNER pair is asserted here, and it is asserted by calling the production predicates
  // against the real captured load. The result is the load-bearing one: both inner escapes FAIL,
  // so this load survives capture on the outer `hardCloseOnly` term alone - i.e. entirely on the
  // owning stack resolving to the GoComet account.
  //
  // The resolution step itself is deliberately NOT re-proved here. scripts/test-gocomet-stack.js
  // :147-157 already boots the real server and asserts srv.stackForRequest ENGINE IDENTITY,
  // including the untagged fallback to stacks[0]. Reimplementing that gate in this file would
  // assert a copy against literals and pass even if production were wrong - which is what this
  // block used to do.
  {
    // The box's live global soft-close block, 2026-08-11. Waaree is deliberately absent: GoComet
    // is scoped through the stack's own allowlist, not through soft-close enrolment.
    const liveSoftClose = {
      enabled: true,
      shippers: ['Havells', 'Dynamic Cables', 'Cords Cable', 'Payal Polyplast', 'Epack',
        'Renewsys', 'Shriji', 'KEI', 'Transrail', 'Vishal', 'Premier', 'Goodluck', 'Safex Chemicals'],
      mode: 'live',
    };
    ok(softAdmitted(liveSoftClose, load) === false,
      'CAPTURE: the real Waaree load is NOT soft-close-enrolled - the inner carve-out does not save it');
    ok(isOutOfHardCloseScope(load) === true,
      'CAPTURE: and it IS out of hard-close scope - so the inner pair alone would refuse it');
  }

  // ---- 7. the fixture carries no credential ----
  //
  // A capture IS a credential (ADR). This endpoint serves the SHIPPER's staff record, password
  // digest included, to an unrelated vendor account - so the guard belongs in the test tree, not
  // only in the README.
  {
    const blob = fs.readdirSync(FIX).filter((f) => f.endsWith('.json'))
      .map((f) => fs.readFileSync(path.join(FIX, f), 'utf8')).join('\n');
    ok(!/\b[0-9a-f]{40}\b/.test(blob), 'fixtures: no 40-hex credential digest survives');
    ok(!/eyJ[A-Za-z0-9_-]{8,}\./.test(blob), 'fixtures: no JWT survives');
    ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(blob), 'fixtures: no email survives');
    ok(!/\b[6-9]\d{9}\b/.test(blob), 'fixtures: no mobile number survives');
    ok(DETAIL.created_by && DETAIL.created_by._redacted,
      'fixtures: `created_by` is redacted-in-place, so the top-level key set stays faithful');
  }

  // ---- completion sentinel ----
  // run-tests.js grades by EXIT CODE alone, so an early return or a swallowed throw would exit 0 as
  // a green zero-assertion run. Assert the count that actually executed.
  assert.strictEqual(fail, 0, `${fail} GoComet live-fixture checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - the file exited early or a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
