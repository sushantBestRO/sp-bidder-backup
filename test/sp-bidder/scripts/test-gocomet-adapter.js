'use strict';
/**
 * GoComet adapter (src/platform/gocometAdapter.js) - Module 2, Phase 1. Offline unit tests
 * with a fully mocked HTTP transport (the house pattern: no live token, no network). Covers:
 *   - capabilities() honest declaration
 *   - login()/ensureSession() offline validation, fail-closed on absent/expired, alert fired
 *   - listAuctions() spot mapping + time bound-check EXCLUDES the year-2100 placeholder
 *   - getAuctionState() bidding-data mapping (live + closed), RTT measured, throttle -> ok:false
 *   - GET budget: min spacing enforced, 429 opens a cooldown that skips the network
 *   - placeBid() double-gated OFF by default; when enabled: fetch-mutate-PUT contract, NUMBER
 *     price, multi-cargo -> single-total, cost-floor belt
 *   - token-expiry alert rail reused with GoComet labels (isolated from SuperProcure)
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { checkTokenExpiry } = require('../src/notify/tokenExpiry');
const { DiscoveryPoller } = require('../src/discovery/discovery');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const DAY = 86400000;

// ---- test doubles ---------------------------------------------------------------------------

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
/** A structurally-valid JWT (header.payload.sig) with the given claims - signature is never checked. */
function makeToken(claims) {
  return `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url(claims)}.sig`;
}
function fakeNotifier() {
  const calls = [];
  return { calls, alert: async (kind, payload, opts) => { calls.push({ kind, payload, opts }); } };
}
/** Build a fake fetch Response the adapter's text-first reader understands. */
function resp(status, body, headers = {}) {
  const isString = typeof body === 'string';
  const hdr = {};
  for (const k of Object.keys(headers)) hdr[k.toLowerCase()] = headers[k];
  return {
    status,
    headers: { get: (h) => (hdr[String(h).toLowerCase()] != null ? hdr[String(h).toLowerCase()] : null) },
    text: async () => (isString ? body : JSON.stringify(body)),
  };
}
/** A recording fetch driven by a route handler(url, init) -> Response. */
function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, init });
    const r = handler(url, init, calls.length);
    return r || resp(404, { error: 'no_route' });
  };
  return { fetchImpl, calls };
}
const noSleep = async () => {};
const fixedNow = (t) => () => t;

const nowSec = () => Math.floor(Date.now() / 1000);
const validToken = () => makeToken({ exp: nowSec() + 30 * 86400, user_id: 'u1', client_id: 'c1', token_type: 'vendor' });

(async () => {
  // ---- capabilities ----
  {
    const a = new GoCometAdapter({ token: validToken(), fetchImpl: makeFetch(() => resp(200, {})).fetchImpl, sleep: noSleep });
    const c = a.capabilities();
    ok(c.standingPriceVisible === false, 'caps: rank-only (standingPriceVisible false)');
    ok(c.revisionLimit === 3, 'caps: revisionLimit 3');
    ok(c.closeModel === 'soft', 'caps: reactive-countdown declared as soft');
    ok(c.reactiveClose === true && c.multiCargo === true, 'caps: reactiveClose + multiCargo true');
    ok(c.transitField === false, 'caps: no transit field');
    ok(c.priceWriteType === 'number', 'caps: price written as a number (verification-pending)');
  }

  // ---- login: absent token fails closed + alerts ----
  {
    const n = fakeNotifier();
    const a = new GoCometAdapter({ token: null, notifier: n });
    let code = null; try { await a.login(); } catch (e) { code = e.code; }
    ok(code === 'AUTH', 'absent token -> login throws AUTH');
    ok(n.calls.some((c) => c.payload.context === 'gocomet'), 'absent token fires an operator alert');
  }

  // ---- login: expired token fails closed + alerts ----
  {
    const n = fakeNotifier();
    const a = new GoCometAdapter({ token: makeToken({ exp: nowSec() - 100, user_id: 'u1' }), notifier: n });
    let code = null; try { await a.login(); } catch (e) { code = e.code; }
    ok(code === 'AUTH', 'expired token -> login throws AUTH');
    ok(n.calls.length >= 1, 'expired token fires an operator alert');
  }

  // ---- login: success parses userId + exp; configured userId overrides claim ----
  {
    const exp = nowSec() + 20 * 86400;
    const a = new GoCometAdapter({ token: makeToken({ exp, user_id: 'u42', client_id: 'c9' }) });
    const acct = await a.login();
    ok(acct.userId === 'u42', 'login parses user_id from the token claim');
    ok(acct.tokenExp === exp * 1000, 'login parses exp (ms)');
    ok(acct.clientId === 'c9', 'login parses client_id');
    const b = new GoCometAdapter({ token: makeToken({ exp, user_id: 'claimUser' }), userId: 'configUser' });
    const acctB = await b.login();
    ok(acctB.userId === 'configUser', 'configured GC_USER_ID overrides the token claim');
  }

  // ---- ensureSession: throws within 60s of expiry ----
  {
    const base = Date.now();
    const exp = base + 30_000; // 30s away
    const a = new GoCometAdapter({ token: makeToken({ exp: Math.floor(exp / 1000), user_id: 'u' }), now: fixedNow(base) });
    await a.login(); // still valid (exp > now)
    let code = null; try { await a.ensureSession(); } catch (e) { code = e.code; }
    ok(code === 'AUTH', 'ensureSession throws AUTH inside the 60s pre-expiry guard');
  }

  // ---- listAuctions: maps spot payload + EXCLUDES the year-2100 placeholder ----
  {
    const base = Date.now();
    const goodTs = new Date(base + 2 * 3600 * 1000).toISOString();
    const { fetchImpl, calls } = makeFetch((url) => {
      if (url.includes('/enquiries/spot')) {
        return resp(200, { data: { current_page: 1, total_page: 1, enquiries: [
          { key: 'K1', origin: 'CHENNAI', destination: 'PUNE', mode: 'FTL', bidding_closed: false, bid_close_timestamp: goodTs, name: '3260-20-14/07', client_company_name: 'Waaree Energies Ltd.' },
          { key: 'K2', origin: 'X', destination: 'Y', bidding_closed: false, bid_close_timestamp: '2100-05-24T19:53:25.000Z' },
        ] } });
      }
      return resp(404, {});
    });
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, now: fixedNow(base) });
    const list = await a.listAuctions({ enrich: false });
    ok(list.length === 1, `year-2100 placeholder excluded (got ${list.length} of 2)`);
    ok(list[0].id === 'K1', 'auction id maps from enquiry key');
    ok(list[0].lane.origin === 'CHENNAI' && list[0].lane.destination === 'PUNE', 'lane maps origin/destination');
    ok(Math.abs(list[0].closesAt - (base + 2 * 3600 * 1000)) < 1000, 'closesAt maps from bid_close_timestamp');
    ok(list[0].status === 'open', 'open enquiry -> status open');
    ok(calls.filter((c) => c.url.includes('/enquiries/spot')).length === 1, 'single page fetched (enquiries < size stops paging)');
    ok(list[0].units === null, 'unenriched load keeps units:null (the safe pre-enrichment shape)');
    ok(!('quoteType' in list[0]), 'unenriched load carries NO quoteType - basis stays genuinely unknown');
    ok(!('rules' in list[0]), 'unenriched load carries no rules block (engine falls back to caps)');
  }

  // ---- listAuctions: enrichment from the enquiry DETAIL (units / basis / slab_rate) ---------
  // cargo_quantity, cargo_unit and slab_rate are detail-only - the live probe confirmed none of
  // them is on the spot list - so the mapped load has no multiplier without this second call.
  {
    const base = Date.now();
    const goodTs = new Date(base + 3600_000).toISOString();
    const listBody = { data: { total_page: 1, enquiries: [
      { key: 'K1', origin: 'A', destination: 'B', bidding_closed: false, bid_close_timestamp: goodTs, show_cost_of_l1_quote: false },
    ] } };
    const { fetchImpl, calls } = makeFetch((url) => {
      if (url.includes('/enquiries/spot')) return resp(200, listBody);
      if (/\/enquiries\/K1$/.test(url)) {
        return resp(200, { data: {
          cargo_quantity: 2.0, cargo_unit: 'TRUCK', slab_rate: 300.0,
          // the leak that must never survive the parse boundary
          created_by: { name: 'Someone', email: 'x@y.z', password_digest: '7e98ae6ce386bd80e87e17f25d10ed99051a1b2c' },
          client_group: { big: 'blob' },
        } });
      }
      return resp(404, {});
    });
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, now: fixedNow(base) });
    const list = await a.listAuctions();
    ok(list[0].units === 2, `units read from cargo_quantity (got ${list[0].units})`);
    ok(list[0].quoteType === 'FTL', 'cargo_unit TRUCK normalizes to the FTL basis');
    ok(list[0].rules && list[0].rules.minDecrement === 300, 'per-enquiry slab_rate becomes the per-unit minDecrement');
    ok(calls.filter((c) => /\/enquiries\/K1$/.test(c.url)).length === 1, 'the detail is fetched once');

    // the projection is an ALLOWLIST - the shipper's password hash must not survive it
    const serialized = JSON.stringify(a._detailCache.get('K1'));
    ok(!/password_digest/.test(serialized), 'password_digest never enters the cache');
    ok(!/client_group|created_by/.test(serialized), 'created_by / client_group dropped at the parse boundary');
    ok(/slab_rate/.test(serialized), 'the allowlisted fields DO survive');

    // second cycle: served from cache, no second detail GET
    await a.listAuctions();
    ok(calls.filter((c) => /\/enquiries\/K1$/.test(c.url)).length === 1, 'a cached detail costs no further call');
  }

  // ---- listAuctions: a quantity with an UNRECOGNISED basis publishes NEITHER ---------------
  // GoComet resolves a 96-entry unit vocabulary; normalizeCargoUnit knows only the TRUCK and
  // weight families. Publishing a bare count for a CONTAINER/PALLET-priced enquiry would put it
  // on the fail-closed-unknown branch, which reads any count>1 as TRUCKS in real mode - a truck
  // control on the price page and an EOD value multiplied by a number that is not trucks.
  {
    const base = Date.now();
    const goodTs = new Date(base + 3600_000).toISOString();
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/enquiries/spot')) {
        return resp(200, { data: { total_page: 1, enquiries: [{ key: 'K1', origin: 'A', destination: 'B', bidding_closed: false, bid_close_timestamp: goodTs }] } });
      }
      return resp(200, { data: { cargo_quantity: 2.0, cargo_unit: 'CONTAINER', slab_rate: 500.0 } });
    });
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, now: fixedNow(base) });
    const list = await a.listAuctions();
    ok(list[0].units === null, 'an unrecognised cargo_unit suppresses units - no bare count without a basis');
    ok(!('quoteType' in list[0]), 'and no basis is invented for it');
    ok(list[0].rules && list[0].rules.minDecrement === 500, 'slab_rate is still usable - it does not depend on the basis');
  }

  // ---- listAuctions: a WEIGHT-family basis publishes neither, because we cannot bid it -------
  // SUPPORTED_QUOTE_BASES is {'TRUCK'} and readQuoteBasis throws BASIS_UNSUPPORTED on everything
  // else, so a per-tonne enquiry is refused at the wire whatever discovery says. Publishing
  // quoteType 'PMT' for it would still DISARM the desk's hard clerical-error floor
  // (hardCostFloorViolation returns null on a PMT basis, since an absolute rupee floor cannot
  // judge an honest Rs 800/MT rate) and relabel the price page per-MT - giving away the
  // missing-digit guard on a load that can never be bid. Degrade to the safe unenriched shape.
  {
    const base = Date.now();
    const goodTs = new Date(base + 3600_000).toISOString();
    for (const unit of ['TON', 'TONS', 'MT', 'TONNE', 'TONNES', 'KG']) {
      const { fetchImpl } = makeFetch((url) => {
        if (url.includes('/enquiries/spot')) {
          return resp(200, { data: { total_page: 1, enquiries: [{ key: 'K1', origin: 'A', destination: 'B', bidding_closed: false, bid_close_timestamp: goodTs }] } });
        }
        return resp(200, { data: { cargo_quantity: 23.0, cargo_unit: unit, slab_rate: 300.0 } });
      });
      const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, now: fixedNow(base) });
      const list = await a.listAuctions();
      ok(!('quoteType' in list[0]), `cargo_unit ${unit} publishes no basis - the desk's hard floor stays armed`);
      ok(list[0].units === null, `cargo_unit ${unit} publishes no bare count either (23 tonnes is not 23 trucks)`);
    }
  }

  // ---- detail cache: the hot path respects the TTL, and neither map grows without bound ------
  // getAuctionState reached into _detailCache directly, so the TTL applied to every caller EXCEPT
  // the one that polls - an expired slab_rate could drive the decrement guard for the whole
  // process lifetime. Both maps also gain one entry per enquiry key ever seen and never shed any.
  {
    let t = Date.now();
    const now = () => t;
    const ttl = 6 * 3600_000;
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/bidding-data')) return resp(200, { data: { bid_closing_in: 600, vendor_rank: 2 } });
      if (url.includes('/enquiries/spot')) {
        return resp(200, { data: { total_page: 1, enquiries: [{ key: 'K1', origin: 'A', destination: 'B', bidding_closed: false, bid_close_timestamp: new Date(t + 3600_000).toISOString() }] } });
      }
      return resp(200, { data: { cargo_quantity: 1.0, cargo_unit: 'TRUCK', slab_rate: 300.0 } });
    });
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, now, detailTtlMs: ttl });
    await a.login();
    await a._fetchEnquiryDetail('K1');
    ok((await a.getAuctionState('K1')).minDecrement === 300, 'a fresh cached slab_rate reaches the hot path');
    t += ttl + 1;
    ok((await a.getAuctionState('K1')).minDecrement === null,
      'an EXPIRED detail no longer feeds the decrement guard - the engine falls back to capabilities()');

    a._detailCache.set('OLD', { at: t - ttl - 1, detail: { slab_rate: 1 } });
    a._detailFailUntil.set('GONE', t - 1);
    a._detailFailUntil.set('STILL_BACKED_OFF', t + 60_000);
    await a.listAuctions();
    ok(!a._detailCache.has('OLD'), 'an expired detail entry is evicted by the list-cycle sweep');
    ok(!a._detailFailUntil.has('GONE'), 'a lapsed failure marker is evicted too');
    ok(a._detailFailUntil.has('STILL_BACKED_OFF'), 'a LIVE failure marker survives - the sweep is not a flush');
    ok(a._detailCache.has('K1'), 'and the sweep does not stop a still-listed load re-enriching');
  }

  // ---- listAuctions: a FAILED detail fetch degrades the load, it does not kill the cycle ----
  {
    const base = Date.now();
    const goodTs = new Date(base + 3600_000).toISOString();
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/enquiries/spot')) {
        return resp(200, { data: { total_page: 1, enquiries: [{ key: 'K1', origin: 'A', destination: 'B', bidding_closed: false, bid_close_timestamp: goodTs }] } });
      }
      return resp(500, 'boom'); // detail fetch fails
    });
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, now: fixedNow(base) });
    const list = await a.listAuctions();
    ok(list.length === 1, 'a failed detail fetch still yields the load');
    ok(list[0].units === null, 'a failed detail fetch degrades to units:null, never a guessed count');
    ok(!('quoteType' in list[0]), 'a failed detail fetch leaves the basis unrecorded rather than assuming trucks');
  }

  // ---- listAuctions: an ERROR WITH A JSON BODY must not poison the cache as a success -------
  // The gate was `!res.json`, so a {"error":"boom"} 500 reached the projection, which returns {}
  // for a payload with no allowlisted key - and {} is truthy, so a failure was cached as a
  // success for the full 6h TTL. The load then never re-enriched even after recovery, and the
  // caller counted it as enriched so the operator saw nothing. Note the identical failure with a
  // PLAINTEXT body behaved correctly: the outcome depended on the error's content type.
  {
    const base = Date.now();
    const goodTs = new Date(base + 3600_000).toISOString();
    for (const errBody of [{ error: 'boom' }, { message: 'nope' }, { errors: ['x'] }, [1, 2, 3]]) {
      let failFirst = true;
      const { fetchImpl, calls } = makeFetch((url) => {
        if (url.includes('/enquiries/spot')) {
          return resp(200, { data: { total_page: 1, enquiries: [{ key: 'K1', origin: 'A', destination: 'B', bidding_closed: false, bid_close_timestamp: goodTs }] } });
        }
        if (failFirst) { failFirst = false; return resp(500, errBody); }
        return resp(200, { data: { cargo_quantity: 4.0, cargo_unit: 'TRUCK', slab_rate: 300.0 } });
      });
      // backoff 0 so the retry is allowed on the very next cycle - we are testing the poisoning,
      // not the backoff
      const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, now: fixedNow(base), detailFailBackoffMs: 0 });
      const c1 = await a.listAuctions();
      ok(c1[0].units === null, `a 500 with body ${JSON.stringify(errBody)} does not enrich`);
      ok(!a._detailCache.has('K1'), 'a failed fetch is NOT written to the success cache');
      const c2 = await a.listAuctions();
      ok(c2[0].units === 4, 'the load re-enriches on the next cycle once the server recovers');
      ok(calls.filter((c) => /\/enquiries\/K1$/.test(c.url)).length === 2, 'the retry actually happened');
    }
  }

  // ---- listAuctions: a 200 carrying none of the wanted fields is not a usable detail --------
  {
    const base = Date.now();
    const goodTs = new Date(base + 3600_000).toISOString();
    const { fetchImpl } = makeFetch((url) => url.includes('/enquiries/spot')
      ? resp(200, { data: { total_page: 1, enquiries: [{ key: 'K1', origin: 'A', destination: 'B', bidding_closed: false, bid_close_timestamp: goodTs }] } })
      : resp(200, { data: { status: 'Open', vendor_rank: 2 } })); // no cargo_quantity, no slab_rate
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, now: fixedNow(base) });
    const list = await a.listAuctions();
    ok(list[0].units === null && !a._detailCache.has('K1'), 'a 200 without the wanted fields is not cached as a detail');
  }

  // ---- listAuctions: a broken enquiry must not starve the budget every cycle ----------------
  {
    const base = Date.now();
    const goodTs = new Date(base + 3600_000).toISOString();
    const enquiries = ['BAD1', 'BAD2', 'GOOD'].map((k) => ({ key: k, origin: 'O', destination: 'D', bidding_closed: false, bid_close_timestamp: goodTs }));
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/enquiries/spot')) return resp(200, { data: { total_page: 1, enquiries } });
      if (/BAD\d$/.test(url)) return resp(500, { error: 'permanently broken' });
      return resp(200, { data: { cargo_quantity: 1.0, cargo_unit: 'TRUCK', slab_rate: 1000.0 } });
    });
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, now: fixedNow(base), detailFailBackoffMs: 120_000 });
    const c1 = await a.listAuctions({ maxDetailFetches: 2 });
    ok(c1.find((l) => l.id === 'GOOD').units === null, 'cycle 1: the two broken loads consume the budget');
    const c2 = await a.listAuctions({ maxDetailFetches: 2 });
    ok(c2.find((l) => l.id === 'GOOD').units === 1,
      'cycle 2: the broken loads are in backoff and no longer starve the healthy one');
  }

  // ---- listAuctions: the detail-fetch budget is bounded per cycle ----
  // Every detail GET pays the inter-read spacing, so an unbounded loop would stall discovery.
  {
    const base = Date.now();
    const goodTs = new Date(base + 3600_000).toISOString();
    const enquiries = ['A', 'B', 'C', 'D'].map((k) => ({ key: k, origin: 'O', destination: 'D', bidding_closed: false, bid_close_timestamp: goodTs }));
    const { fetchImpl, calls } = makeFetch((url) => {
      if (url.includes('/enquiries/spot')) return resp(200, { data: { total_page: 1, enquiries } });
      return resp(200, { data: { cargo_quantity: 1.0, cargo_unit: 'TRUCK', slab_rate: 1000.0 } });
    });
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, now: fixedNow(base) });
    const list = await a.listAuctions({ maxDetailFetches: 2 });
    const detailCalls = calls.filter((c) => !c.url.includes('/enquiries/spot')).length;
    ok(detailCalls === 2, `detail fetches capped at the budget (got ${detailCalls})`);
    ok(list.length === 4, 'every load still maps, budget or not');
    ok(list.filter((l) => l.units === 1).length === 2, 'the two enriched loads carry units');
    ok(list.filter((l) => l.units === null).length === 2, 'the rest degrade to units:null this cycle');
  }

  // ---- listAuctions: show_cost_of_l1_quote is carried through from the LIST item ----
  {
    const base = Date.now();
    const goodTs = new Date(base + 3600_000).toISOString();
    const { fetchImpl } = makeFetch((url) => url.includes('/enquiries/spot')
      ? resp(200, { data: { total_page: 1, enquiries: [
        { key: 'W', origin: 'A', destination: 'B', bidding_closed: false, bid_close_timestamp: goodTs, show_cost_of_l1_quote: false },
        { key: 'X', origin: 'A', destination: 'B', bidding_closed: false, bid_close_timestamp: goodTs, show_cost_of_l1_quote: true },
      ] } })
      : resp(404, {}));
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, now: fixedNow(base) });
    const list = await a.listAuctions({ enrich: false });
    ok(list[0].showsL1 === false, 'a shipper hiding L1 maps showsL1:false');
    ok(list[1].showsL1 === true, 'a shipper exposing L1 is visible at discovery, with no extra call');
  }

  // ---- getAuctionState: minDecrement is served from the discovery-time cache ----
  // bidding-data has 7 keys and slab_rate is not one of them, so the hot path can only know it
  // if discovery already fetched it. Unknown must stay null, not a fabricated number.
  {
    const base = Date.now();
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/bidding-data')) return resp(200, { data: { bid_closing_in: 600, vendor_rank: 2, revisions_left: 3, total_revisions: 0 } });
      if (/\/enquiries\/K1$/.test(url)) return resp(200, { data: { cargo_quantity: 1.0, cargo_unit: 'TRUCK', slab_rate: 300.0 } });
      return resp(404, {});
    });
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, now: fixedNow(base) });
    await a.login();
    const before = await a.getAuctionState('K1');
    ok(before.minDecrement === null, 'an unenriched enquiry reports minDecrement null, never a guess');
    await a._fetchEnquiryDetail('K1');
    const after = await a.getAuctionState('K1');
    ok(after.minDecrement === 300, `minDecrement served from the cached slab_rate (got ${after.minDecrement})`);
    ok(after.closesInMs === 600000, 'the hot path still reads its countdown from bidding-data');
  }

  // ---- placeBid: revisions are read honestly from a response that has no revision field -----
  // The submit response is the whole quote (52 keys) and NONE of them matches /revis/. The old
  // `revisions_left ?? revisionsLeft` was two names for a field that does not exist.
  {
    const mk = (submitBody) => {
      const q = { id: 'QR', charges_list: { '11_freight_charges': { freight_charges_custom_charge_x: { units: 1, unit_name: 'TRUCK', price: 1 } } },
        total_charges: { total: { units: 1.0, quote_units: 1.0, unit_name: 'TRUCK' } } };
      const { fetchImpl } = makeFetch((url, init) => {
        if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [q]);
        if (init.method === 'PUT') return resp(200, { data: submitBody });
        return resp(404, {});
      });
      return new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl, sleep: noSleep });
    };
    // the real shape: rank present, no revision field anywhere
    const a = mk({ quote_rank: 3, status: 'submitted', can_submit_quote: true, bid_closing_in: 471 });
    await a.login();
    const r = await a.placeBid('KR', 50000, { floor: 1000 });
    ok(r.myRank === 3, 'rank comes from quote_rank, the only rank field on the response');
    ok(r.revisionsLeft === null, 'no revision field on the wire -> null, not a fabricated number');
    ok(r.canSubmitAgain === true, 'can_submit_quote is surfaced as the one budget bit we do get');
    ok(r.bidClosingInMs === 471000, 'the server-overridden bid_closing_in is carried out as a free extension detector');

    // budget exhausted: GoComet flips can_submit_quote to false on the submit that spends the last one
    const b = mk({ quote_rank: 3, can_submit_quote: false });
    await b.login();
    const rb = await b.placeBid('KR', 50000, { floor: 1000 });
    ok(rb.revisionsLeft === 0, 'can_submit_quote:false is GoComet stating the budget is gone -> 0');
    ok(rb.canSubmitAgain === false, 'and it is surfaced directly too');

    // A CLOSED enquiry sends bid_closing_in: null. Number(null) is 0 and Number.isFinite(0) is
    // true, so the coercing form reported "closes in 0ms" on the very response whose meaning is
    // that bidding is over. Absent and explicit-null must both read as "not reported".
    const c = mk({ quote_rank: 3, can_submit_quote: false, bid_closing_in: null });
    await c.login();
    const rc = await c.placeBid('KR', 50000, { floor: 1000 });
    ok(rc.bidClosingInMs === null, `an explicit null close time is "not reported", never 0ms (got ${rc.bidClosingInMs})`);
    const d2 = mk({ quote_rank: 3, can_submit_quote: false });
    await d2.login();
    const rd = await d2.placeBid('KR', 50000, { floor: 1000 });
    ok(rd.bidClosingInMs === null, 'an absent close time is null too');
  }

  // ---- latency: the snipe budget covers GET+PUT, and the write RTT excludes the stall -------
  {
    const a = new GoCometAdapter({ token: validToken() });
    ok(a.capabilities().snipeBudgetMs === 4500, 'caps declare a 4.5s runway (quote GET ~0.4s + the confirming re-read behind the ~1s GET ceiling + submit ~2.5s, serial)');
    ok(a.assumedRttMs === 1100, 'assumed write RTT is the measured GoComet median, not SuperProcure 200ms');
    ok(a.writeTimeoutMs === 8000, 'submit timeout gives real headroom over the 2,482ms observed max');
  }
  {
    // The spacing gate must not stall a bid behind the full polling interval. Clock is frozen,
    // so without the cap the quote GET would sleep the whole minGetIntervalMs.
    const sleeps = [];
    const base = Date.now();
    const q = { id: 'QT', charges_list: { '11_freight_charges': { freight_charges_custom_charge_x: { units: 1, unit_name: 'TRUCK', price: 1 } } },
      total_charges: { total: { units: 1.0, quote_units: 1.0, unit_name: 'TRUCK' } } };
    const { fetchImpl } = makeFetch((url, init) => {
      if (url.includes('/bidding-data')) return resp(200, { data: { bid_closing_in: 30, vendor_rank: 1, revisions_left: 3, total_revisions: 0 } });
      if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [q]);
      if (init.method === 'PUT') return resp(200, { data: { quote_rank: 1 } });
      return resp(404, {});
    });
    const a = new GoCometAdapter({
      token: validToken(), bidEnabled: true, fetchImpl, now: fixedNow(base),
      sleep: async (ms) => { sleeps.push(ms); }, minGetIntervalMs: 5000, writeGetSpacingCapMs: 1000,
    });
    await a.login();
    await a.getAuctionState('K1');                      // arms the spacing gate
    const r = await a.placeBid('K1', 50000, { floor: 1000 });
    ok(r.accepted === true, 'the bid still goes out');
    // TWO waits, because placeBid now re-reads the quote before it submits. The second is 2,000ms
    // rather than 1,000 only because the clock here is FROZEN: the spacing cap is an offset from
    // now(), which never advances, while the global GET ceiling keeps stepping - on a moving clock
    // both waits are 1,000ms. What the cap actually guarantees is unchanged and is what this pins:
    // neither GET sits out the 5s polling interval. The global ceiling is deliberately not
    // skippable by a write deadline, so a wait AT the ceiling is the intended floor, not a leak.
    ok(sleeps.length === 2, `the quote read and its confirming re-read each take a slot (waits=${JSON.stringify(sleeps)})`);
    ok(sleeps.every((ms) => ms < 5000), `the write-path quote GETs never sit out the full 5s interval (waits=${JSON.stringify(sleeps)})`);
    ok(a.lastWriteRttMs === 0, 'lastWriteRttMs is the SUBMIT leg alone, not the spacing stall + GET + PUT');
  }

  // ---- capabilities: the minDecrement fallback is no longer fail-open ----
  {
    const a = new GoCometAdapter({ token: validToken() });
    ok(a.capabilities().minDecrement === 1000,
      'caps minDecrement is the largest observed slab_rate, not 0 (0 is falsy and disables the guard)');
  }

  // ---- listAuctions: 401 fails closed with AUTH ----
  {
    const n = fakeNotifier();
    const { fetchImpl } = makeFetch(() => resp(401, 'Unauthorized'));
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, notifier: n });
    let code = null; try { await a.listAuctions(); } catch (e) { code = e.code; }
    ok(code === 'AUTH', 'list 401 -> AUTH');
    ok(n.calls.length >= 1, 'list 401 alerts the operator');
  }

  // ---- getAuctionState: live bidding-data maps to the seam shape ----
  {
    const base = Date.now();
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/bidding-data')) {
        return resp(200, { data: { bid_closing_in: 6215, bid_opening_in: null, vendor_rank: 2,
          total_revisions: 0, revisions_left: 3, current_server_time: new Date(base).toISOString() } });
      }
      return resp(404, {});
    });
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, now: fixedNow(base) });
    await a.login();
    const s = await a.getAuctionState('K1');
    ok(s.ok === true && s.status === 'live', 'live load -> ok + status live');
    ok(Math.abs(s.closesInMs - 6215000) <= 500 && (base + s.closesInMs) % 1000 === 0,
      `ruling 51: closesInMs = bid_closing_in placed on the nearest whole-second close by the server stamp (got ${s.closesInMs})`);
    ok(s.myRank === 2, 'myRank = vendor_rank');
    ok(s.revisionsLeft === 3, 'revisionsLeft = revisions_left');
    ok(s.revisionLimit === 3, 'revisionLimit = revisions_left + total_revisions');
    ok(s.standingL1Price === null, 'rank-only: standingL1Price null');
    ok(typeof s.measuredRttMs === 'number', 'measuredRttMs is a number for latency compensation');
  }

  // ---- getAuctionState: closed load (bid_closing_in null) ----
  {
    const { fetchImpl } = makeFetch((url) => url.includes('/bidding-data')
      ? resp(200, { data: { bid_closing_in: null, vendor_rank: 1, total_revisions: 1, revisions_left: 2 } })
      : resp(404, {}));
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep });
    await a.login();
    const s = await a.getAuctionState('K9');
    ok(s.ok === true && s.status === 'closed', 'null bid_closing_in -> status closed');
    ok(s.closesInMs === 0, 'closed load -> closesInMs 0');
  }

  // ---- getAuctionState: a body-less 304 is a SKIPPED TICK, never a closed auction ----
  // Regression pin for the silent-total-loss bug: a 304 carries content-length 0, so the body
  // parse yields null. The old code read that as bd={} -> Number(undefined)=NaN -> status
  // 'closed' + closesInMs 0 on a LIVE auction, and two of those in a row finalize the monitor
  // terminally. GoComet ETags every read, so the shape is real (reproduced live on
  // suggested-quotes); it is dormant only because we never send if-none-match.
  {
    const { fetchImpl } = makeFetch((url) => url.includes('/bidding-data')
      ? resp(304, '', { etag: 'W/"718c803e"' })
      : resp(404, {}));
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep });
    await a.login();
    const s = await a.getAuctionState('K1');
    ok(s.ok === false, '304 -> ok:false (skip the tick), NOT a parsed body');
    ok(s.notModified === true, '304 is reported as notModified so a caller can tell it apart');
    ok(s.status !== 'closed', '304 must NEVER be read as a closed auction');
    ok(s.closesInMs !== 0, '304 must never produce a closesInMs of 0 (that finalizes the monitor)');
  }

  // ---- getAuctionState: a 200 whose body lacks bid_closing_in is also a skipped tick ----
  // The general form of the same defence - "the key is absent" is a read failure, while an
  // explicit null is the genuine close signal. bd={} used to collapse those two into 'closed'.
  {
    const { fetchImpl } = makeFetch((url) => url.includes('/bidding-data')
      ? resp(200, { data: { vendor_rank: 2, revisions_left: 3, total_revisions: 0 } }) // no bid_closing_in
      : resp(404, {}));
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep });
    await a.login();
    const s = await a.getAuctionState('K1');
    ok(s.ok === false && s.malformedBody === true, 'a body missing bid_closing_in -> ok:false, not closed');
    ok(s.status !== 'closed', 'an absent countdown key is a read failure, never a close signal');
  }

  // ---- getAuctionState: an EXPLICIT null bid_closing_in is still the real close signal ----
  // Guards the fix from over-correcting: distinguishing absent from null is the point, so null
  // must keep meaning closed (confirmed live) even though absent now means "skip".
  {
    const { fetchImpl } = makeFetch((url) => url.includes('/bidding-data')
      ? resp(200, { data: { bid_closing_in: null, vendor_rank: 1, total_revisions: 3, revisions_left: 0 } })
      : resp(404, {}));
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep });
    await a.login();
    const s = await a.getAuctionState('K1');
    ok(s.ok === true && s.status === 'closed', 'an EXPLICIT null bid_closing_in still reads as closed');
  }

  // ---- getAuctionState: a NON-NULL but unusable bid_closing_in is a read failure, not a close ----
  // Only an explicit null means closed (confirmed live). A string, object, array, boolean or
  // Infinity is a schema change under us, and reading one as a close is TERMINAL.
  {
    // Infinity is deliberately absent: JSON.stringify turns it into null, so a real JSON
    // response can never carry it - including it would test the harness, not the adapter.
    for (const bad of ['soon', '00:05:00', {}, { value: 300 }, [], false]) {
      const { fetchImpl } = makeFetch((url) => url.includes('/bidding-data')
        ? resp(200, { data: { bid_closing_in: bad, vendor_rank: 1 } })
        : resp(404, {}));
      const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep });
      await a.login();
      const s = await a.getAuctionState('K1');
      ok(s.ok === false && s.status !== 'closed', `bid_closing_in ${JSON.stringify(bad)} -> read failure, not closed`);
    }
    // and coercion must not INVENT a countdown either
    for (const bad of [[300], true]) {
      const { fetchImpl } = makeFetch((url) => url.includes('/bidding-data')
        ? resp(200, { data: { bid_closing_in: bad, vendor_rank: 1 } })
        : resp(404, {}));
      const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep });
      await a.login();
      const s = await a.getAuctionState('K1');
      ok(s.ok === false, `bid_closing_in ${JSON.stringify(bad)} must not coerce into a live countdown`);
    }
  }

  // ---- getAuctionState: an implausibly large countdown is a placeholder, not a live auction ----
  // The same year-2100 doctrine _boundedParseMs applies to close timestamps. It was applied to
  // the list path and never to the countdown.
  {
    const { fetchImpl } = makeFetch((url) => url.includes('/bidding-data')
      ? resp(200, { data: { bid_closing_in: 3153600000, vendor_rank: 1 } }) // ~100 years
      : resp(404, {}));
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep });
    await a.login();
    const s = await a.getAuctionState('K1');
    ok(s.ok === false && s.implausibleCountdown === true, 'a 100-year countdown is refused, not armed');
  }

  // ---- getAuctionState: measuredRttMs is the WRITE-latency proxy, never this read's own span ----
  // The seam contract (realAdapter.js getAuctionState, pinned for SP by test-adapter-wire.js) is
  // that measuredRttMs answers "how long does a BID take to land", because the engine computes
  // oneway = measuredRttMs/2 and gates the snipe on it. GoComet reads run ~30-45ms while submits
  // ran 645/1,070/2,482ms, so reporting any flavour of read span - the wall span OR the
  // spacing-excluded network span - hands the engine a runway roughly two orders of magnitude
  // shorter than the write it is timing, and the bid is released far too late to land.
  {
    let t = 1_000_000;
    const now = () => t;
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/bidding-data')) { t += 250; return resp(200, { data: { bid_closing_in: 600, vendor_rank: 1 } }); }
      return resp(404, {});
    });
    const a = new GoCometAdapter({
      token: validToken(), fetchImpl, now, minGetIntervalMs: 5000, assumedRttMs: 1100,
      sleep: async (ms) => { t += ms; }, // the spacing sleep advances the same clock
    });
    await a.login();
    const first = await a.getAuctionState('K1');
    ok(first.measuredRttMs === 1100,
      `before any write, rtt is the assumed WRITE latency, not the 250ms read (got ${first.measuredRttMs})`);
    t += 500; // only 500ms later -> 4500ms of spacing owed
    const second = await a.getAuctionState('K1');
    ok(second.measuredRttMs === 1100,
      `our own 4.5s spacing wait never leaks into rtt either (got ${second.measuredRttMs})`);
    // Once a real submit has been timed, THAT is what the engine must compensate for.
    a.lastWriteRttMs = 2482; // the observed worst-case submit
    const third = await a.getAuctionState('K1');
    ok(third.measuredRttMs === 2482,
      `a measured write RTT supersedes the assumption (got ${third.measuredRttMs})`);
    ok(third.ok === true && third.closesInMs === 600_000, 'the state read itself still works normally');
  }

  // ---- getAuctionState: the skip/failure paths report the same write proxy -------------------
  // A tick that returns ok:false still carries measuredRttMs, and it must be the same quantity as
  // the success path - a read failure says nothing about how long a write takes.
  {
    const { fetchImpl } = makeFetch(() => resp(429, 'Too Many Requests'));
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, assumedRttMs: 900 });
    await a.login();
    const s = await a.getAuctionState('K1');
    ok(s.ok === false && s.measuredRttMs === 900, 'a throttled read reports the write proxy, not its own span');
  }

  // ---- getAuctionState: 429 -> ok:false, and the cooldown skips the network on the next read ----
  {
    const base = Date.now();
    const { fetchImpl, calls } = makeFetch(() => resp(429, 'Too Many Requests'));
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep, now: fixedNow(base) });
    await a.login();
    const s1 = await a.getAuctionState('K1');
    ok(s1.ok === false, '429 -> ok:false (engine skips the tick)');
    const s2 = await a.getAuctionState('K1');
    ok(s2.ok === false, 'still throttled on the immediate retry');
    ok(calls.length === 1, 'cooldown skips the network on the second read (no hammering the limiter)');
  }

  // ---- GET budget: minimum spacing between reads is enforced ----
  {
    const base = Date.now();
    const sleeps = [];
    const sleep = async (ms) => { sleeps.push(ms); };
    const { fetchImpl } = makeFetch((url) => url.includes('/bidding-data')
      ? resp(200, { data: { bid_closing_in: 100, vendor_rank: 1, revisions_left: 3, total_revisions: 0 } })
      : resp(404, {}));
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep, now: fixedNow(base), minGetIntervalMs: 5000 });
    await a.login();
    await a.getAuctionState('K1'); // first GET: no wait
    await a.getAuctionState('K1'); // second GET: clock frozen -> must wait the full interval
    ok(sleeps.length === 1 && sleeps[0] === 5000, `second GET waits minGetIntervalMs (sleeps=${JSON.stringify(sleeps)})`);
  }

  // ---- placeBid: refuses when GC_BID is off (default), no network touched ----
  {
    const { fetchImpl, calls } = makeFetch(() => resp(200, {}));
    const a = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: noSleep }); // bidEnabled default false
    await a.login();
    let code = null; try { await a.placeBid('K1', 10000); } catch (e) { code = e.code; }
    ok(code === 'WRITE_DISABLED', 'placeBid refuses when GC_BID is off');
    ok(calls.length === 0, 'a refused bid never touches the network');
  }

  // ---- placeBid: refuses when writeEnabled backstop is down, even with GC_BID on ----
  {
    const a = new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl: makeFetch(() => resp(200, {})).fetchImpl, sleep: noSleep });
    a.writeEnabled = false; // the kill-switch backstop
    await a.login();
    let code = null; try { await a.placeBid('K1', 10000); } catch (e) { code = e.code; }
    ok(code === 'WRITE_DISABLED', 'placeBid refuses when writeEnabled is down (kill-switch)');
  }

  // ---- placeBid: enabled -> fetch-mutate-PUT contract, NUMBER price, single charge line ----
  // Shaped after the real observed quote: ONE 11_freight_charges group with ONE
  // freight_charges_custom_charge* line, carrying its own units/unit_name, plus the normalized
  // total_charges block the basis check reads.
  {
    const mkQuote = () => ({
      id: 'Q1',
      charges_list: { '11_freight_charges': {
        display_name: 'Freight',
        freight_charges_custom_charge_40ft: { units: 2, unit_name: "TRUCK TONS 25 40'X8'X8.8') - (LXWXH 40FT", price: 111.5 },
      } },
      total_charges: { total: { units: 2.0, quote_units: 2.0, unit_name: 'TRUCK', total: 223.0 } },
    });
    const quote = mkQuote();
    const { fetchImpl, calls } = makeFetch((url, init) => {
      if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quote]);
      if (init.method === 'PUT' && url.includes('/quotes/Q1/submit')) return resp(201, { data: { quote_rank: 1, can_submit_quote: true } });
      return resp(404, {});
    });
    const a = new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl, sleep: noSleep });
    await a.login();
    const r = await a.placeBid('K1', 12345.6, { floor: 1000 });
    ok(r.accepted === true, 'accepted on 201');
    ok(r.myRank === 1, 'maps rank from the submit response quote_rank');
    const put = calls.find((c) => c.method === 'PUT');
    ok(put && put.url.includes('/api/v1/vendor/quotes/Q1/submit'), 'PUTs to /quotes/{id}/submit');
    const body = JSON.parse(put.init.body);
    const fc = body.quote.charges_list['11_freight_charges'];
    ok(fc.freight_charges_custom_charge_40ft.price === 12346, 'price written rounded to the freight line');
    ok(typeof fc.freight_charges_custom_charge_40ft.price === 'number', 'price is a NUMBER, not a string');
    ok(fc.freight_charges_custom_charge_40ft.units === 2, 'the line units are READ, never rewritten');
    // the original GET-fetched quote is deep-cloned, not mutated in place
    ok(quote.charges_list['11_freight_charges'].freight_charges_custom_charge_40ft.price === 111.5, 'source quote untouched (deep clone)');
    // the wire total the server will compute is reported back for the read-back oracle
    ok(r.wireTotal === 12346 * 2, `wireTotal reports amount x units (got ${r.wireTotal})`);
  }

  // ---- placeBid: a MULTI-LINE quote is PRICED, one per-unit rate on every truck-type line ----
  // This block pinned the opposite until 2026-08-19. The old refusal rested on "one amount on
  // every line bids N times the intended total", which is wrong: `price` is per UNIT and the
  // server multiplies each line by its own units and sums. Full case coverage (asymmetric units,
  // accessorials, currency, floor) is scripts/test-gocomet-multi-truck-type.js; this keeps the
  // shape-level pin here so the two cannot drift apart unnoticed.
  {
    const quote = { id: 'Q2', charges_list: { '11_freight_charges': {
      freight_charges_custom_charge_40ft: { units: 1, unit_name: 'TRUCK', price: 100, currency: 'INR' },
      freight_charges_custom_charge_20ft: { units: 1, unit_name: 'TRUCK', price: 200, currency: 'INR' },
    } }, total_charges: { total: { units: 2.0, quote_units: 1.0, unit_name: 'TRUCK' } } };
    const { fetchImpl, calls } = makeFetch((url, init) => {
      if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quote]);
      if (init.method === 'PUT' && url.includes('/quotes/Q2/submit')) return resp(200, { data: { quote_rank: 2 } });
      return resp(404, {});
    });
    const a = new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl, sleep: noSleep });
    await a.login();
    const r = await a.placeBid('K2', 50000, { floor: 1000 });
    ok(r.accepted === true, 'a two-truck-type quote is bid, not refused');
    const fc = JSON.parse(calls.find((c) => c.method === 'PUT').init.body).quote.charges_list['11_freight_charges'];
    ok(fc.freight_charges_custom_charge_40ft.price === 50000 && fc.freight_charges_custom_charge_20ft.price === 50000,
      'the same PER-UNIT rate is written to both truck-type lines');
    ok(r.wireTotal === 50000 * 2, `wireTotal is the SUM over the priced lines (got ${r.wireTotal})`);
    ok(r.cargoLines === 2, 'the result reports how many lines were priced');
  }

  // ---- placeBid: a quote with TWO freight GROUPS is refused ----
  // Distinct from the multi-LINE case: _freightContainer returns one group, so the multi-line
  // guard only counts lines inside the group it picked. Two groups would slip past it - we would
  // price the first and leave the second at its stale price, and GoComet sums the groups. That
  // is a mispriced bid in an unpredictable direction, harder to spot than a clean N-fold.
  {
    const quote = { id: 'Q3', charges_list: {
      '11_freight_charges': { freight_charges_custom_charge_a: { units: 1, unit_name: 'TRUCK', price: 100 } },
      '12_freight_charges': { freight_charges_custom_charge_b: { units: 1, unit_name: 'TRUCK', price: 999 } },
    }, total_charges: { total: { units: 1.0, quote_units: 1.0, unit_name: 'TRUCK' } } };
    const { fetchImpl, calls } = makeFetch((url, init) => {
      if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quote]);
      return resp(404, {});
    });
    const a = new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl, sleep: noSleep });
    await a.login();
    let err = null; try { await a.placeBid('K3', 50000, { floor: 1000 }); } catch (e) { err = e; }
    ok(err && err.code === 'MULTI_FREIGHT_GROUP', `two freight groups refused (got ${err && err.code})`);
    ok(err && err.groups && err.groups.length === 2, 'the refusal names the groups it found');
    ok(!calls.some((c) => c.method === 'PUT'), 'a multi-group quote never reaches the wire');
  }
  {
    // and the single-group fallback path still works when the canonical key is absent
    const quote = { id: 'Q4', charges_list: {
      '13_freight_charges': { freight_charges_custom_charge_a: { units: 1, unit_name: 'TRUCK', price: 100 } },
    }, total_charges: { total: { units: 1.0, quote_units: 1.0, unit_name: 'TRUCK' } } };
    const { fetchImpl, calls } = makeFetch((url, init) => {
      if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quote]);
      if (init.method === 'PUT') return resp(200, { data: { quote_rank: 1 } });
      return resp(404, {});
    });
    const a = new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl, sleep: noSleep });
    await a.login();
    const r = await a.placeBid('K4', 50000, { floor: 1000 });
    ok(r.accepted === true, 'a single non-canonical freight group is still priced (numbering drift tolerated)');
    const put = calls.find((c) => c.method === 'PUT');
    ok(JSON.parse(put.init.body).quote.charges_list['13_freight_charges'].freight_charges_custom_charge_a.price === 50000,
      'the fallback group is the one written to');
  }

  // ---- capabilities: we CAN price a multi-line quote, with one per-unit rate on every line ----
  {
    const a = new GoCometAdapter({ token: validToken() });
    const c = a.capabilities();
    ok(c.multiCargo === true, 'caps: the PLATFORM supports multi-cargo (unchanged, a real fact)');
    ok(c.multiCargoBidSupported === true, 'caps: and we can price one - still declared separately, because it is a fact about US');
  }

  // ---- placeBid: pricing-basis guards (the 23-50x per-tonne trap) --------------------------
  // A quote factory shaped after the real observed payload; each case perturbs one field.
  const basisQuote = (over = {}) => ({
    id: 'QB',
    charges_list: { '11_freight_charges': {
      freight_charges_custom_charge_40ft: Object.assign(
        { units: 2, unit_name: "TRUCK TONS 25 40'X8'X8.8') - (LXWXH 40FT", price: 1 }, over.line || {}),
    } },
    total_charges: { total: Object.assign({ units: 2.0, quote_units: 2.0, unit_name: 'TRUCK' }, over.total || {}) },
  });
  const basisAdapter = (q) => {
    const { fetchImpl, calls } = makeFetch((url, init) => {
      if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [q]);
      if (init.method === 'PUT') return resp(200, { data: { quote_rank: 2 } });
      return resp(404, {});
    });
    return { a: new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl, sleep: noSleep }), calls };
  };

  {
    // THE TRAP: the per-line unit_name contains "TONS" but the load is PER-TRUCK. A substring
    // check on that field misclassifies 100% of the real sample. The normalized field decides.
    const { a } = basisAdapter(basisQuote());
    await a.login();
    const r = await a.placeBid('KB', 50000, { floor: 1000 });
    ok(r.accepted === true, 'a per-line unit_name containing TONS does NOT block a per-TRUCK load');
    ok(r.unitName === 'TRUCK', 'basis is read from the normalized total_charges.total.unit_name');
    ok(r.units === 2, 'units read from the validated multiplier');
  }
  {
    // A genuinely per-tonne line is refused - this is the 12-45x underbid class.
    const { a, calls } = basisAdapter(basisQuote({ total: { unit_name: 'TON', units: 50.0, quote_units: 50.0 }, line: { units: 50 } }));
    await a.login();
    let err = null; try { await a.placeBid('KB', 50000, { floor: 1000 }); } catch (e) { err = e; }
    ok(err && err.code === 'BASIS_UNSUPPORTED', `a per-TON basis is refused (got ${err && err.code})`);
    ok(err && err.unitName === 'TON', 'the refusal names the basis it saw');
    ok(!calls.some((c) => c.method === 'PUT'), 'a refused basis never PUTs');
  }
  {
    const { a } = basisAdapter(basisQuote({ line: { units: 3 } })); // line disagrees with totals
    await a.login();
    let err = null; try { await a.placeBid('KB', 50000, { floor: 1000 }); } catch (e) { err = e; }
    ok(err && err.code === 'UNITS_DISAGREE', `disagreeing units carriers are refused (got ${err && err.code})`);
  }
  {
    const q = basisQuote(); delete q.total_charges;
    const { a } = basisAdapter(q);
    await a.login();
    let code = null; try { await a.placeBid('KB', 50000, { floor: 1000 }); } catch (e) { code = e.code; }
    ok(code === 'BASIS_UNKNOWN', `a quote with no total_charges is refused (got ${code})`);
  }
  {
    const { a } = basisAdapter(basisQuote({ total: { units: 0, quote_units: 0 }, line: { units: 0 } }));
    await a.login();
    let code = null; try { await a.placeBid('KB', 50000, { floor: 1000 }); } catch (e) { code = e.code; }
    ok(code === 'UNITS_UNREADABLE', `a zero/absent multiplier is refused, never assumed 1 (got ${code})`);
  }

  {
    // A single units carrier cannot corroborate itself - the agreement check would pass
    // trivially while its docblock claims four fields agreed.
    const q = basisQuote(); delete q.total_charges.total.quote_units; delete q.charges_list['11_freight_charges'].freight_charges_custom_charge_40ft.units;
    const { a } = basisAdapter(q);
    await a.login();
    let code = null; try { await a.placeBid('KB', 50000, { floor: 1000 }); } catch (e) { code = e.code; }
    ok(code === 'UNITS_UNCORROBORATED', `a lone units carrier is refused (got ${code})`);
  }
  {
    // Number() would have turned each of these into a confident multiplier out of a non-number.
    for (const bad of [true, [2], ' 2 ', '2']) {
      const { a } = basisAdapter(basisQuote({ total: { units: bad, quote_units: bad }, line: { units: bad } }));
      await a.login();
      let code = null; try { await a.placeBid('KB', 50000, { floor: 1000 }); } catch (e) { code = e.code; }
      ok(code === 'UNITS_UNREADABLE', `a non-number units ${JSON.stringify(bad)} is refused (got ${code})`);
    }
  }
  {
    // There is no such thing as 1.5 trucks - SuperProcure's assertValidVcq rejects a fraction
    // for the same reason.
    const { a } = basisAdapter(basisQuote({ total: { units: 1.5, quote_units: 1.5 }, line: { units: 1.5 } }));
    await a.login();
    let code = null; try { await a.placeBid('KB', 50000, { floor: 1000 }); } catch (e) { code = e.code; }
    ok(code === 'UNITS_FRACTIONAL', `a fractional multiplier is refused (got ${code})`);
  }

  // ---- placeBid: a PARTIAL vehicle count is refused (GoComet has no per-bid count field) ----
  {
    const { a, calls } = basisAdapter(basisQuote()); // units: 2
    await a.login();
    let err = null; try { await a.placeBid('KB', 50000, { floor: 1000, vcq: 1 }); } catch (e) { err = e; }
    ok(err && err.code === 'PARTIAL_VEHICLE_COUNT', `a partial vcq is refused (got ${err && err.code})`);
    ok(err && err.units === 2 && err.requested === 1, 'the refusal reports requested vs available');
    ok(!calls.some((c) => c.method === 'PUT'), 'a partial-count bid never reaches the wire');
  }
  {
    const { a } = basisAdapter(basisQuote()); // units: 2
    await a.login();
    const rFull = await a.placeBid('KB', 50000, { floor: 1000, vcq: 2 });
    ok(rFull.accepted === true, 'a vcq equal to the full count is honoured (that is what GoComet does anyway)');
    const { a: b } = basisAdapter(basisQuote());
    await b.login();
    const rSentinel = await b.placeBid('KB', 50000, { floor: 1000, vcq: -1 });
    ok(rSentinel.accepted === true, 'the -1 single/unspecified sentinel is honoured');
  }

  // ---- placeBid: cost-floor belt rejects a sub-floor amount before anything is sent ----
  {
    const { fetchImpl, calls } = makeFetch(() => resp(200, []));
    const a = new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl, sleep: noSleep });
    await a.login();
    let code = null; try { await a.placeBid('K1', 500, { floor: 1000 }); } catch (e) { code = e.code; }
    ok(code === 'FLOOR', 'sub-floor bid throws FLOOR');
    ok(calls.length === 0, 'floor belt fires BEFORE any network call');
  }

  // ---- placeBid: a throttled quote fetch is RATE_LIMITED, not a mislabelled NO_QUOTE ----
  // The cooldown is SYNTHETIC - _request returns a 429 without issuing anything - so a rate
  // limit tripped by an unrelated background read used to silently kill the next bid on a
  // different auction and report it as "this enquiry has nothing submittable".
  {
    const base = Date.now();
    const { fetchImpl, calls } = makeFetch(() => resp(429, 'Too Many Requests'));
    const a = new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl, sleep: noSleep, now: fixedNow(base) });
    await a.login();
    await a.getAuctionState('K1');            // trips the cooldown
    const before = calls.length;
    let err = null; try { await a.placeBid('K1', 10000, { floor: 1000 }); } catch (e) { err = e; }
    ok(err && err.code === 'RATE_LIMITED', `throttled quote fetch -> RATE_LIMITED (got ${err && err.code})`);
    ok(err && err.localCooldown === true, 'the local-cooldown case is flagged as such (no request was issued)');
    ok(calls.length === before, 'a cooldown-aborted bid issues no further network call');
  }

  // ---- placeBid: a network error on the quote fetch is NETWORK, not NO_QUOTE ----
  {
    const a = new GoCometAdapter({
      token: validToken(), bidEnabled: true, sleep: noSleep,
      fetchImpl: async () => { throw new Error('ECONNRESET'); },
    });
    await a.login();
    let code = null; try { await a.placeBid('K1', 10000, { floor: 1000 }); } catch (e) { code = e.code; }
    ok(code === 'NETWORK', `quote-fetch network error -> NETWORK (got ${code})`);
  }

  // ---- placeBid: a genuinely empty quote list still throws NO_QUOTE ----
  // Guards against over-correcting: NO_QUOTE must keep meaning what it says.
  {
    const { fetchImpl } = makeFetch((url, init) => (init.method === 'GET' && url.includes('/quotes')) ? resp(200, []) : resp(404, {}));
    const a = new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl, sleep: noSleep });
    await a.login();
    let code = null; try { await a.placeBid('K1', 10000, { floor: 1000 }); } catch (e) { code = e.code; }
    ok(code === 'NO_QUOTE', 'a real, parsed, empty quote list is still NO_QUOTE');
  }

  // ---- _mapEnquiry names the shipper under the key every consumer reads --------------------
  // The mapper emitted `shipper`, and NOTHING above the seam reads that off a load: discovery's
  // softAdmitted and matchesAllowlist, priceRequests, margin resolution and every alert-routing
  // scope key all read `companyName` (what realAdapter._mapLoad emits). So the whole integration
  // matched its allowlist against undefined.
  {
    const base = Date.now();
    const a = new GoCometAdapter({ token: validToken(), sleep: noSleep, now: fixedNow(base) });
    const m = a._mapEnquiry({
      key: 'GC-NAME', origin: 'A', destination: 'B', bidding_closed: false,
      bid_close_timestamp: new Date(base + 3600_000).toISOString(),
      client_company_name: 'Waaree Energies Ltd.',
    });
    ok(m.companyName === 'Waaree Energies Ltd.', 'companyName carries client_company_name');
    ok(!('shipper' in m), 'the dead `shipper` key is gone - one vocabulary per fact, no second name to bind to');
    ok(a._mapEnquiry({ key: 'GC-NONAME', bid_close_timestamp: new Date(base + 3600_000).toISOString() }).companyName === null,
      'an enquiry with no client_company_name maps companyName null, never undefined');
  }

  // ---- END TO END: a real DiscoveryPoller ADMITS a GoComet load off its shipper allowlist ----
  // The assertion that proves the fix rather than the rename. It runs the real listAuctions path
  // into the real poller with NO field patched in between - which is what the close-model scope
  // test could not do (it hand-adds companyName to isolate its own gate).
  {
    const base = Date.now();
    const rawEnquiry = (over) => Object.assign({
      key: 'GC-ADMIT', origin: 'Bhiwandi', destination: 'Hosur', mode: '32ft SXL',
      bidding_closed: false, bid_close_timestamp: new Date(base + 30 * 60_000).toISOString(),
      client_company_name: 'Waaree Energies Ltd.',
    }, over);
    const listOf = (e) => async () => resp(200, { data: { enquiries: [e], total_page: 1 } });

    const load = (await new GoCometAdapter({
      token: validToken(), sleep: noSleep, now: fixedNow(base), fetchImpl: listOf(rawEnquiry()),
    }).listAuctions({ enrich: false }))[0];

    // hardCloseOnly OFF isolates the shipper filter: a GoComet load is softClose, and the
    // close-model gate would otherwise exclude it for an unrelated (correct) reason.
    const poller = new DiscoveryPoller({
      adapter: {}, requests: {}, notifier: {},
      config: { allowlist: { shippers: ['Waaree'], lanes: [], hardCloseOnly: false } },
    });
    ok(poller.matchesAllowlist(load) === true,
      'a real DiscoveryPoller ADMITS the mapped load against a configured shipper allowlist');

    const other = (await new GoCometAdapter({
      token: validToken(), sleep: noSleep, now: fixedNow(base),
      fetchImpl: listOf(rawEnquiry({ client_company_name: 'Some Other Shipper Ltd.' })),
    }).listAuctions({ enrich: false }))[0];
    ok(poller.matchesAllowlist(other) === false,
      'and REJECTS an off-allowlist shipper - the poller is matching the name, not admitting blindly');

    // The soft-close opt-in path (discovery.softAdmitted) reads companyName too, and it is the one
    // that matters for GoComet: an extending load reaches intake on a hard-close-only deployment
    // ONLY through an explicit per-shipper enrolment.
    const softPoller = new DiscoveryPoller({
      adapter: {}, requests: {}, notifier: {},
      config: {
        allowlist: { shippers: [], lanes: [], hardCloseOnly: true },
        softClose: { enabled: true, shippers: ['Waaree'] },
      },
    });
    ok(softPoller.matchesAllowlist(load) === true,
      'the soft-close opt-in admits the enrolled GoComet load on a hard-close-only deployment');
  }

  // ---- getAuctionState publishes the close-model vocabulary the engine already speaks ---------
  {
    const base = Date.now();
    const bd = (over) => async (url) => (url.includes('/bidding-data')
      ? resp(200, { data: Object.assign({
        bid_closing_in: 6215, vendor_rank: 2, total_revisions: 0, revisions_left: 3,
        current_server_time: new Date(base).toISOString(),
      }, over) })
      : resp(404, {}));
    const mk = async (over) => {
      const a = new GoCometAdapter({ token: validToken(), sleep: noSleep, now: fixedNow(base), fetchImpl: bd(over) });
      await a.login();
      return a.getAuctionState('K1');
    };

    // live
    {
      const s = await mk({});
      ok(s.extendMs === 300_000, 'live: extendMs seeded at the measured ~299s increment');
      ok(s.closesAtMs % 1000 === 0 && Math.abs(s.closesAtMs - (base + 6215000)) <= 500,
        'ruling 51: live closesAtMs = server clock + the platform countdown, snapped to the nearest whole second');
      ok(s.extendCount === null, 'live: extendCount (the CAP, not a count) is null - GoComet publishes none');
      ok(Object.prototype.hasOwnProperty.call(s, 'extensionCeiling') && s.extensionCeiling === null,
        'live: extensionCeiling is PRESENT and null - "no cap exists", not "cap unknown"');
      ok(s.biddingClosed === null, 'live: an absent bidding_closed reads as "not reported", never false');
      // The property the whole fix exists for: our own GET spacing is 5,000ms, so two consecutive
      // polls must NOT be able to outlast the debounce bidEngine.js:1403 builds from this field.
      ok(s.extendMs + 3000 > 5000, 'the published extendMs makes the finalize debounce outlast the adapter GET spacing');
    }

    // closed on the FIRST read of this enquiry - nothing was ever observed live, so there is
    // nothing to freeze. Asserted through the CONSUMER's own expression (bidEngine.js:1047) and
    // not on the field alone, because the field alone is what a null passes: Number(null) is a
    // finite 0, so publishing null here retires the load reporting a close at epoch 1970.
    {
      const s = await mk({ bid_closing_in: null });
      ok(s.status === 'closed' && s.closesInMs === 0, 'closed: unchanged status/countdown handling');
      ok(!Object.prototype.hasOwnProperty.call(s, 'closesAtMs'),
        'never-seen-live + closed: the closesAtMs key is OMITTED, exactly as origin/main published it');
      ok((Number.isFinite(Number(s.closesAtMs)) ? Number(s.closesAtMs) : null) === null,
        'and the engine consumer resolves that to null - the branch a real close time would not take');
      ok((Number.isFinite(Number(null)) ? Number(null) : null) === 0,
        'the coercion being avoided: the SAME expression over a published null yields a finite 0, not null');
      ok(s.extendMs === 300_000, 'closed: extendMs is a platform constant, still published');
      ok(s.extendCount === null && s.extensionCeiling === null, 'closed: the cap fields are unchanged');
    }

    // live -> closed on ONE adapter: the close FREEZES at the last live value.
    {
      let secs = 6215;
      const { fetchImpl } = makeFetch((url) => (url.includes('/bidding-data')
        ? resp(200, { data: { bid_closing_in: secs, vendor_rank: 2, total_revisions: 0, revisions_left: 3,
          current_server_time: new Date(base).toISOString() } })
        : resp(404, {})));
      const a = new GoCometAdapter({ token: validToken(), sleep: noSleep, now: fixedNow(base), fetchImpl });
      await a.login();
      const live = await a.getAuctionState('K-FREEZE');
      secs = null;
      const shut = await a.getAuctionState('K-FREEZE');
      ok(shut.status === 'closed', 'freeze: the second read is genuinely closed');
      ok(live.closesAtMs % 1000 === 0 && Math.abs(live.closesAtMs - (base + 6215000)) <= 500
        && shut.closesAtMs === live.closesAtMs,
        'freeze: the closed read publishes the LAST LIVE close, by value - not null, not a sliding "now" (ruling 51: the whole-second close)');
      ok((Number.isFinite(Number(shut.closesAtMs)) ? Number(shut.closesAtMs) : null) === live.closesAtMs,
        'freeze: and the engine consumer reads back that exact epoch, never 0 (ruling 51: the whole-second close)');
      // _observeExtension sizes every jump against monitor.believedCloseAt, seeded from the live
      // read. A frozen close makes that jump 0, so a dead auction still being polled cannot
      // manufacture a phantom round - and the sustained-zero inference at bidEngine.js:1801 stays
      // reachable, which a null closesAtMs makes structurally impossible (it returns at :1764).
      ok(shut.closesAtMs - live.closesAtMs === 0,
        'freeze: the jump the engine would see across live -> closed is exactly 0');
      ok((await a.getAuctionState('K-FREEZE')).closesAtMs === shut.closesAtMs,
        'freeze: and it does not move on a further poll of the dead auction either');
      ok(!Object.prototype.hasOwnProperty.call(await a.getAuctionState('K-OTHER'), 'closesAtMs'),
        'freeze: the memory is PER-ENQUIRY - a different closed enquiry gets no borrowed close');
    }

    // bidding_closed: true, alongside a still-live countdown
    {
      const s = await mk({ bidding_closed: true });
      ok(s.biddingClosed === true, 'bidding_closed true is surfaced (it was read for the LIST status and never here)');
      ok(s.status === 'live', 'and it deliberately does NOT drive status - a TERMINAL finalize never rides an unverified flag');
      const f = await mk({ bidding_closed: false });
      ok(f.biddingClosed === false, 'an explicit false is carried as false, distinct from the absent case');
    }
  }

  // ---- ENGINE BOUNDARY: extendMs is what stops a zeroed countdown abandoning a live auction ----
  // The regression for the defect itself, against a REAL BidEngine driving the REAL adapter at its
  // real 5,000ms GET spacing. The control is the same adapter publishing an increment of ZERO, and
  // it must finalize, or this assertion proves nothing.
  //
  // Zero, not an ABSENT field. The two are different facts and the engine now reads them that way
  // (extendIncrementMs): a published zero is the platform stating this branch runs no anti-snipe
  // rounds, so the settle window is the bare clock-skew guard; an absent one is the platform having
  // said nothing, and collapsing that to the same 3s is what retired live auctions ~180s early. Only
  // zero is a legitimate falsifier here - a deleted field now widens the window, as it must.
  {
    const base = Date.now();
    // revisions_left 0 stands the engine down from BIDDING without touching the finalize path,
    // which is the whole point of the block. With a budget left, the first tick's placeBid throws
    // WRITE_DISABLED (GC_BID is off) and the engine spends the next spaced GET verifying whether
    // that bid landed - so the second read is the verification, not a second tick, and no amount
    // of waiting reaches the debounce check being tested.
    const zeroed = () => async (url) => (url.includes('/bidding-data')
      ? resp(200, { data: { bid_closing_in: 0, vendor_rank: 2, total_revisions: 3, revisions_left: 0,
        current_server_time: new Date(base).toISOString() } })
      : resp(404, {}));
    const armMeta = () => ({ id: '1', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() });
    const engCfg = { finalizeDebounceMs: 3000, openAtMs: 15_000, floorWindowMs: 2_500 };

    const run = async (tag, zeroIncrement) => {
      const a = new GoCometAdapter({ token: validToken(), fetchImpl: zeroed() });
      await a.login();
      if (zeroIncrement) {
        const inner = a.getAuctionState.bind(a);
        a.getAuctionState = async (id) => { const s = await inner(id); s.extendMs = 0; return s; };
      }
      const f = path.join(os.tmpdir(), `gc-fin-${tag}-${process.pid}.json`);
      const eng = new BidEngine(a, new DurableScheduler(f), { config: engCfg });
      eng.arm(armMeta(), { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] });
      await new Promise((r) => setTimeout(r, 8000));
      const finalized = !!(eng.monitors.get('1') || {}).finalized;
      eng.kill(); try { fs.unlinkSync(f); } catch (_) {}
      return finalized;
    };

    const [withExtend, withoutExtend] = await Promise.all([run('fixed', false), run('control', true)]);
    ok(withExtend === false,
      'a countdown held at zero for 8s does NOT finalize when extendMs is published (debounce = 300s + 3s)');
    ok(withoutExtend === true,
      'CONTROL: the same run with the increment published as ZERO DOES finalize - two polls at 5s spacing clear the bare 3s debounce');
  }

  // ---- token-expiry alert rail: reused with GoComet labels, isolated from SuperProcure ----
  {
    const n = fakeNotifier();
    const base = Date.now();
    await checkTokenExpiry({ tokenExp: base + 10 * DAY, notifier: n, now: base,
      accountLabel: 'gocomet', product: 'GoComet', tokenKind: 'gc-token' });
    ok(n.calls.length === 2, '10 days left -> the 30 + 14 day thresholds fire');
    ok(n.calls.every((c) => c.payload.context === 'gc-token-gocomet'), 'context uses the GoComet token kind');
    ok(n.calls.every((c) => c.payload.detail.startsWith('GoComet token')), 'alert wording says GoComet, not SuperProcure');
    ok(n.calls.every((c) => c.opts.dedupeKey.startsWith('token_expiry_warn_gocomet_')), 'dedupe key scoped to the gocomet label');
  }

  // keep a hard assert so a thrown/late failure still trips a non-zero exit
  assert.strictEqual(fail, 0, `${fail} GoComet adapter checks failed`);

  // COMPLETION SENTINEL - not decoration, and do not delete it as redundant.
  // scripts/run-tests.js grades every test file by its EXIT CODE ALONE. A file that exits 0
  // early - an early return, an unref'd timer, a rejected promise nobody awaited, an async path
  // that simply never resolves - is scored as a PASS having asserted nothing at all. The
  // `fail === 0` assert above cannot catch that, because a run that never reached its assertions
  // also never incremented `fail`. Asserting a FLOOR on the number of checks that actually ran
  // is what makes a silent zero-assertion run impossible: if the body exits before here the
  // process leaves 0 and this line never executes, and if it reaches here having skipped blocks
  // the count is short and the assert throws. Raise the floor whenever checks are added.
  const MIN_EXPECTED_CHECKS = 217;
  assert.ok(pass >= MIN_EXPECTED_CHECKS,
    `completion sentinel: only ${pass} checks ran, expected at least ${MIN_EXPECTED_CHECKS} - the suite exited early and would otherwise have scored as a silent green`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
