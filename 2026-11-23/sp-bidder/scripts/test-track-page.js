'use strict';
/**
 * /track/:token - the tokenized READ-ONLY live-bid view (reuses the price token).
 * Asserts: page + state endpoint render/serve for a known token; unknown token 404s;
 * there is NO write path under /track (POSTs 404, nothing mutates); the state JSON
 * never exposes the floor/ladder/cost; the armed and closed phases both project.
 * Boots the app in mock mode over the memory store on an ephemeral port.
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
// the mock stack's DurableScheduler writes intents.json on arm - keep it out of data/
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-track-page-'));

const http = require('http');
const { app, requests, store } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

function req(method, url, { body = null, contentType = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) {
      headers['content-type'] = contentType || 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); },
    );
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => req('GET', base + p);
  const postForm = (p, kv) => req('POST', base + p, { body: new URLSearchParams(kv).toString(), contentType: 'application/x-www-form-urlencoded' });

  const now = Date.now();
  const rT = await requests.createForLoad({
    id: 'TRK-1', lane: { origin: 'Bhiwandi, MH', destination: 'Bawal, HR' }, equipment: '20ft container',
    units: 1, companyName: 'Syngenta India', closesAt: now + 10 * 60_000, startsAt: now - 60_000,
    softClose: false, status: 'live',
  });

  // ---- unknown token: page + state both 404 ----
  ok((await get('/track/zzzz-not-a-token')).status === 404, 'unknown token page -> 404');
  const su = await get('/track/zzzz-not-a-token/state');
  ok(su.status === 404 && su.json && su.json.error, 'unknown token state -> 404 JSON error');

  // ---- awaiting phase: page renders read-only, state degrades gracefully (no monitor) ----
  const g0 = await get(`/track/${rT.id}`);
  ok(g0.status === 200 && /Live bid status/.test(g0.text), 'track page renders');
  // The fixture lane is real SuperProcure output and carries the portal's OWN two-letter state
  // suffix ("Bhiwandi, MH"), which it appends on some branches and not others - one half of the
  // inconsistency the shared lane formatter exists to remove. The suffix is now stripped, on this
  // portal for the same reason it is stripped on the other, so this asserts the cities. The state
  // is not lost: it is in the full address row on the load card below.
  ok(/Bhiwandi -> Bawal/.test(g0.text) && /Syngenta India/.test(g0.text), 'track page shows lane + shipper');
  ok(!/<form/.test(g0.text) && !/<button/.test(g0.text), 'track page has no form and no buttons (read-only)');
  const s0 = await get(`/track/${rT.id}/state`);
  ok(s0.status === 200 && s0.json.requestStatus === 'awaiting_price', 'state carries the request status');
  ok(s0.json.engine === null && s0.json.outcome === null, 'no monitor yet -> engine/outcome null (graceful)');
  ok(typeof s0.json.serverTime === 'number' && s0.json.closesAt === rT.load.closesAt, 'state carries serverTime + closesAt for the countdown');

  // ---- the state JSON never exposes the money internals ----
  const raw0 = JSON.stringify(s0.json);
  ok(!/"floor"|"ladder"|"cost"|"marginsPct"|"minMarginPct"/.test(raw0), 'state exposes no floor/ladder/cost/margins');

  // ---- armed phase (via the real capture path): engine block projects rank/price ----
  await postForm(`/price/${rT.id}`, { cost: '80000' });
  const s1 = await get(`/track/${rT.id}/state`);
  ok(s1.status === 200 && s1.json.requestStatus === 'armed', 'state reflects armed after capture');
  ok(s1.json.engine && typeof s1.json.engine === 'object', 'engine block present after arming');
  ok(s1.json.engine && 'myRank' in s1.json.engine && 'lastBidPrice' in s1.json.engine, 'engine block carries rank + last bid price');
  ok(!/"floor"|"ladder"|"cost"|"marginsPct"/.test(JSON.stringify(s1.json)), 'armed state still exposes no floor/ladder/cost');

  // ---- read-only: no POST route exists under /track, and nothing mutated ----
  ok((await postForm(`/track/${rT.id}`, { cost: '1' })).status === 404, 'POST /track/:token -> 404 (no write path)');
  ok((await postForm(`/track/${rT.id}/state`, { x: '1' })).status === 404, 'POST /track/:token/state -> 404 (no write path)');
  const after = await requests.getByToken(rT.id);
  ok(after.status === 'armed' && after.price && after.price.cost === 80000, 'track hits mutated nothing (request unchanged)');

  // ---- closed phase: outcome projected from the History record ----
  await store.patchDoc('priceRequests', rT.id, { status: 'closed' });
  await store.putDoc('closedBids', 'TRK-1', { auctionId: 'TRK-1', lane: rT.load.lane, shipper: 'Syngenta India', won: true, finalRank: 1, lastBidPrice: 84000, ourBids: [], closedAt: Date.now(), status: 'closed' });
  const s2 = await get(`/track/${rT.id}/state`);
  ok(s2.json.outcome && s2.json.outcome.won === true && s2.json.outcome.finalRank === 1 && s2.json.outcome.lastBidPrice === 84000, 'closed state carries the final outcome');
  ok((await get(`/track/${rT.id}`)).status === 200, 'track page still renders after close');

  // ---- stopped phase: two different reasons must not collapse into the same terminal claim ----
  // 'stopped' is reached two ways - an operator pausing an armed, resumable auction (stop()) and
  // the system parking a captured cost it cannot bid yet (holdUnbiddable()) - and renderRequestStatus
  // (server.js:4957) already tells them apart. render() in renderTrackPage() used to name neither
  // and fell through to "Auction ended" for both, so a paused-but-live auction (or a saved-but-held
  // one) told the desk the money-path was over. See server.js:5052.

  // (A) server-side wiring: heldReason must project onto /track's state for both writers, and
  // holdUnbiddable() must be reachable WITHOUT ever passing through 'armed' - the fix's own
  // rationale for treating a held load as unreachable via the price-form link depends on this.
  const rP = await requests.createForLoad({
    id: 'TRK-STOP', lane: { origin: 'Bhiwandi, MH', destination: 'Bawal, HR' }, equipment: '20ft container',
    units: 1, companyName: 'Syngenta India', closesAt: now + 10 * 60_000, startsAt: now - 60_000,
    softClose: false, status: 'live',
  });
  await postForm(`/price/${rP.id}`, { cost: '80000' });
  await requests.stop(rP.id);
  const sStopped = await get(`/track/${rP.id}/state`);
  ok(sStopped.status === 200 && sStopped.json.requestStatus === 'stopped' && sStopped.json.heldReason === null,
    'operator stop() on an armed load -> /track state carries stopped + heldReason null');

  const rH = await requests.createForLoad({
    id: 'TRK-HELD', lane: { origin: 'Bhiwandi, MH', destination: 'Bawal, HR' }, equipment: '20ft container',
    units: 1, companyName: 'Syngenta India', closesAt: now + 10 * 60_000, startsAt: now - 60_000,
    softClose: false, status: 'live',
  });
  ok(rH.status === 'awaiting_price', 'held fixture starts awaiting_price, never priced or armed');
  await requests.holdUnbiddable(rH.id, 'platform_bidding_disabled');
  const rHAfter = await requests.getByToken(rH.id);
  ok(rHAfter.status === 'stopped', 'holdUnbiddable() reaches stopped directly from awaiting_price - a held load never passes through armed');
  const sHeld = await get(`/track/${rH.id}/state`);
  ok(sHeld.status === 200 && sHeld.json.requestStatus === 'stopped' && sHeld.json.heldReason === 'platform_bidding_disabled',
    'holdUnbiddable() -> /track state carries stopped + heldReason');

  // (B) client-side render(): run the ACTUAL shipped <script>, not a re-implementation of it - the
  // gap between what the source says and what the template literal emits is exactly what broke this
  // class of page before, undetected, for four days (test-price-page-js.js).
  function extractRenderScript(html) {
    const blocks = [];
    const re = /<script>([\s\S]*?)<\/script>/g;
    for (let m = re.exec(html); m; m = re.exec(html)) blocks.push(m[1]);
    return blocks.filter((b) => /function render\(/.test(b)).pop();
  }
  async function renderState(html, state) {
    const src = extractRenderScript(html);
    const statEl = { innerHTML: '' };
    const cdEl = { style: {}, textContent: '', getAttribute: () => String(Date.now() + 60_000) };
    const byId = { stat: statEl, cd: cdEl };
    const document = { getElementById: (id) => byId[id] || null };
    const location = { pathname: `/track/${rP.id}` };
    const fetchStub = () => Promise.resolve({ ok: true, json: () => Promise.resolve(state) });
    const noop = () => {};
    function DateStub(...a) { return new Date(...a); }
    DateStub.now = () => Date.now();
    // eslint-disable-next-line no-new-func
    new Function('document', 'location', 'fetch', 'setTimeout', 'setInterval', 'Date', src)(
      document, location, fetchStub, noop, noop, DateStub,
    );
    for (let i = 0; i < 8; i++) await Promise.resolve();
    return statEl.innerHTML;
  }

  const trackHtml = (await get(`/track/${rP.id}`)).text;
  ok(!!extractRenderScript(trackHtml), 'track page carries the render() script to test against');

  const opStopped = await renderState(trackHtml, { requestStatus: 'stopped', heldReason: null, engine: null, outcome: null });
  ok(!/Auction ended/.test(opStopped), 'operator-paused state does not render as Auction ended');
  ok(/pause/i.test(opStopped), 'operator-paused state names the pause, not a false close');

  const heldDisabled = await renderState(trackHtml, { requestStatus: 'stopped', heldReason: 'platform_bidding_disabled', engine: null, outcome: null });
  ok(!/Auction ended/.test(heldDisabled), 'held (platform not live) state does not render as Auction ended');
  ok(/saved/i.test(heldDisabled), 'held (platform not live) state says the cost is saved, not that the auction ended');

  const heldOther = await renderState(trackHtml, { requestStatus: 'stopped', heldReason: 'platform_stack_unavailable', engine: null, outcome: null });
  ok(!/Auction ended/.test(heldOther), 'held (other reason) state does not render as Auction ended');

  // ---- V1-F01 regression: the stopped branch must apply the SAME lapse test its server twin
  // applies FIRST (server.js:4970), before ever reading heldReason - the mirror-image of the
  // original bug: a CLOSED auction must not render as a live, resumable one.
  const lapsedClosesAt = Date.now() - 60_000;
  const lapsedOpStopped = await renderState(trackHtml, { requestStatus: 'stopped', heldReason: null, closesAt: lapsedClosesAt, serverTime: Date.now(), engine: null, outcome: null });
  ok(/Auction ended/.test(lapsedOpStopped), 'lapsed operator-stopped state renders Auction ended, not resumable (V1-F01)');
  ok(!/pause/i.test(lapsedOpStopped), 'lapsed operator-stopped state does not claim the auction is paused/resumable');

  const lapsedHeld = await renderState(trackHtml, { requestStatus: 'stopped', heldReason: 'platform_stack_unavailable', closesAt: lapsedClosesAt, serverTime: Date.now(), engine: null, outcome: null });
  ok(/Auction ended/.test(lapsedHeld), 'lapsed held state also renders Auction ended, not the held-cost-saved message (V1-F01)');

  // guards the guard: a real future close must still take the paused/held branch, not always
  // "Auction ended" once closesAt is merely present
  const notLapsedStopped = await renderState(trackHtml, { requestStatus: 'stopped', heldReason: null, closesAt: Date.now() + 5 * 60_000, serverTime: Date.now(), engine: null, outcome: null });
  ok(!/Auction ended/.test(notLapsedStopped) && /pause/i.test(notLapsedStopped), 'not-yet-lapsed operator-stopped state still renders as paused/resumable');

  // ---- V1-F02 regression: heldReason must not survive a rearm - hold -> rearm -> a genuine
  // operator stop must report the operator's own decision, not a stale portal-fault reason
  // (server.js:2892; the sticky-field hazard is a merge-store patch, priceRequests.js:780).
  const rR = await requests.createForLoad({
    id: 'TRK-REARM', lane: { origin: 'Bhiwandi, MH', destination: 'Bawal, HR' }, equipment: '20ft container',
    units: 1, companyName: 'Syngenta India', closesAt: now + 10 * 60_000, startsAt: now - 60_000,
    softClose: false, status: 'live',
  });
  await requests.holdUnbiddable(rR.id, 'platform_bidding_disabled');
  const rRHeld = await requests.getByToken(rR.id);
  ok(rRHeld.status === 'stopped' && rRHeld.heldReason === 'platform_bidding_disabled', 'V1-F02 fixture: holdUnbiddable sets stopped + heldReason');
  await requests.rearm(rR.id);
  const rRRearmed = await requests.getByToken(rR.id);
  ok(rRRearmed.status === 'armed' && rRRearmed.heldReason === null, 'rearm() clears heldReason, not just stoppedAt (V1-F02)');
  await requests.stop(rR.id);
  const sOpAfterHold = await get(`/track/${rR.id}/state`);
  ok(sOpAfterHold.status === 200 && sOpAfterHold.json.requestStatus === 'stopped' && sOpAfterHold.json.heldReason === null,
    'operator stop() after a prior hold+rearm reports heldReason null, not the stale portal-fault reason (V1-F02)');

  // ---- a close nobody saw must not print "Result: Lost" on a shareable link ----
  // outcomeFor admits any record with status 'closed'. Pre-sweep an orphan's record stayed 'open',
  // so it returned null and this page said nothing; the sweep now closes it with won null, and
  // trackState's `!!outcome.won` turned that into false for a renderer with only two branches. Every
  // one of the 52 GoComet orphans would assert a loss here while History, both exports and the
  // participation report all say unknown - a false claim to a human, contradicting the system's own
  // other surfaces. renderRequestStatus, the sibling status page, has always guarded this.
  const { CLOSED_UNKNOWN_LABEL } = require('../src/web/exportModel');
  const rU = await requests.createForLoad({
    id: 'TRK-UNK', lane: { origin: 'Bhiwandi, MH', destination: 'Bawal, HR' }, equipment: '20ft container',
    units: 1, companyName: 'Syngenta India', closesAt: now + 10 * 60_000, startsAt: now - 60_000,
    softClose: false, status: 'live',
  });
  await store.patchDoc('priceRequests', rU.id, { status: 'closed' });
  await store.putDoc('closedBids', 'TRK-UNK', {
    auctionId: 'TRK-UNK', lane: rU.load.lane, shipper: 'Syngenta India',
    won: null, finalRank: null, lastBidPrice: 84000, closedWhileDown: true,
    ourBids: [{ price: 84000, ts: Date.now() - 60_000 }], closedAt: Date.now(), status: 'closed',
  });
  const sU = await get(`/track/${rU.id}/state`);
  ok(sU.json.outcome && sU.json.outcome.won === null,
    `the state projects won as null, not a coerced false (got ${JSON.stringify(sU.json.outcome && sU.json.outcome.won)})`);
  ok(sU.json.outcome && sU.json.outcome.resultStatus === 'closed_unknown',
    `and it carries the CANONICAL status, decided by exportModel.deriveStatus rather than by a local won == null test (got ${JSON.stringify(sU.json.outcome && sU.json.outcome.resultStatus)})`);

  const unknownRendered = await renderState(trackHtml, { requestStatus: 'closed', engine: null, outcome: { won: null, resultStatus: 'closed_unknown', finalRank: null, lastBidPrice: 84000 } });
  ok(unknownRendered.includes(CLOSED_UNKNOWN_LABEL),
    'and the page prints the shared unknown label, worded identically to the History badge and the export cell');
  ok(!/Lost/.test(unknownRendered), 'never "Lost" - that is a claim about an auction nobody watched finish');

  // ---- a load that never bid is No-bid here too, not "we could not see how it ended" ----
  // outcomeFor admits any record with status 'closed' without inspecting ourBids, and the renderer
  // decided on won == null alone - so a load armed and retired before its first rung took the
  // unknown branch on the ONE link the desk forwards, while History, both exports, the EOD and the
  // participation report all say No-bid. Two answers for one load is the exact disagreement the
  // unknown class was introduced to remove.
  const rN = await requests.createForLoad({
    id: 'TRK-NOBID', lane: { origin: 'Bhiwandi, MH', destination: 'Bawal, HR' }, equipment: '20ft container',
    units: 1, companyName: 'Syngenta India', closesAt: now + 10 * 60_000, startsAt: now - 60_000,
    softClose: false, status: 'live',
  });
  await store.patchDoc('priceRequests', rN.id, { status: 'closed' });
  await store.putDoc('closedBids', 'TRK-NOBID', {
    auctionId: 'TRK-NOBID', lane: rN.load.lane, shipper: 'Syngenta India',
    won: null, finalRank: null, lastBidPrice: null, closedWhileDown: true,
    ourBids: [], closedAt: Date.now(), status: 'closed',
  });
  const sN = await get(`/track/${rN.id}/state`);
  ok(sN.json.outcome && sN.json.outcome.resultStatus === 'no_bid',
    `zero bids outranks the unknown test, exactly as deriveStatus orders it (got ${JSON.stringify(sN.json.outcome && sN.json.outcome.resultStatus)})`);
  const noBidRendered = await renderState(trackHtml, { requestStatus: 'closed', engine: null, outcome: { won: null, resultStatus: 'no_bid', finalRank: null, lastBidPrice: null } });
  ok(/No-bid/.test(noBidRendered) && !noBidRendered.includes(CLOSED_UNKNOWN_LABEL),
    `the page prints No-bid, the same word every other surface uses (got "${noBidRendered}")`);

  // Guards the guard: the two settled verdicts must be untouched.
  const wonRendered = await renderState(trackHtml, { requestStatus: 'closed', engine: null, outcome: { won: true, resultStatus: 'won', finalRank: 1, lastBidPrice: 84000 } });
  ok(/WON/.test(wonRendered) && !wonRendered.includes(CLOSED_UNKNOWN_LABEL), 'a real win still prints WON');
  const lostRendered = await renderState(trackHtml, { requestStatus: 'closed', engine: null, outcome: { won: false, resultStatus: 'lost', finalRank: 4, lastBidPrice: 84000 } });
  ok(/Lost/.test(lostRendered) && !lostRendered.includes(CLOSED_UNKNOWN_LABEL), 'a real loss still prints Lost');
  ok(!/[–—]/.test(CLOSED_UNKNOWN_LABEL), 'the label carries no en/em dash - this link is forwarded to a phone');

  server.close();

  // COMPLETION SENTINEL. run-tests.js grades a file by EXIT STATUS only, so a file that returns
  // early - an unref'd timer, an early return, a swallowed rejection - exits 0 having asserted
  // nothing and is scored a pass. Pinning the count makes a vacuous green impossible.
  const EXPECTED_CHECKS = 44;
  const ran = pass + fail;
  if (ran !== EXPECTED_CHECKS) {
    console.error(`  FAIL - completion sentinel: ran ${ran} checks, expected ${EXPECTED_CHECKS} (a check was skipped or added without updating EXPECTED_CHECKS)`);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  console.log(`\n${pass} passed, ${fail} failed (${ran}/${EXPECTED_CHECKS} checks reached the sentinel)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
