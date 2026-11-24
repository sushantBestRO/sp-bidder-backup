'use strict';
/**
 * /price/:token non-open states (armed / expired / closed / dismissed) render a real
 * status page on BOTH GET and POST - never the raw "Could not save: price-request not
 * open" string (that text fired in front of the client mid-test). Raw errors remain
 * only for genuinely unknown tokens and bad input; JSON callers keep JSON errors.
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
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-price-states-'));

const http = require('http');
const { app, requests, store } = require('../src/web/server');
const { publicSeg } = require('../src/pricing/priceRequests');

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
  const postJson = (p, obj) => req('POST', base + p, { body: JSON.stringify(obj) });

  const now = Date.now();
  const mkLoad = (id) => ({
    id, lane: { origin: 'Khopoli', destination: 'Keeranur' }, equipment: 'Trailer', units: 1,
    companyName: 'Syngenta India', closesAt: now + 10 * 60_000, startsAt: now - 60_000,
    softClose: false, status: 'live',
  });

  // ---- awaiting: the form renders (baseline) ----
  // These fixtures close FAST on purpose (seconds), which is what the engine under test needs.
  // createForLoad would otherwise DERIVE deadlineAt = closesAt - 90s lead, landing it in the past -
  // a request production cannot create (discovery refuses to open one inside the lead) and which
  // capture() now rightly refuses. So hold the pricing window open explicitly: deadlineAt gates
  // capture() alone and never engine timing, so closesAt (and every assertion below) is unchanged.
  const rA = await requests.createForLoad(mkLoad('PPS-1'), { deadlineAt: Date.now() + 60_000 });
  const g0 = await get(`/price/${rA.id}`);
  ok(g0.status === 200 && /Enter your rate/.test(g0.text), 'awaiting -> the rate form renders');
  ok(!/href="\/track\//.test(g0.text), 'awaiting form (not yet priced) has no live-rank link - there is no bid to show yet');

  // ---- capture -> Cost saved, then GET renders the RE-PRICE form (same link, now editable) ----
  const p0 = await postForm(`/price/${rA.id}`, { cost: '80000' });
  ok(p0.status === 200 && /Cost saved/.test(p0.text), 'first POST captures the cost (Cost saved)');
  const g1 = await get(`/price/${rA.id}`);
  ok(g1.status === 200, 'armed GET -> 200 page, not an error status');
  ok(/Re-price load/.test(g1.text), 'armed GET -> the re-price form, not the old dead-end page');
  ok(/id="cost"[^>]*value="80000"/.test(g1.text), 'armed GET prefills the EDITABLE cost input with the captured cost');
  ok(/<form/.test(g1.text) && /name="m_0"/.test(g1.text), 'armed GET renders an editable band form');
  const rA1state = await requests.getByToken(rA.id);
  ok(g1.text.includes(`<a class="track" href="/track/${publicSeg(rA1state)}">See rank and last bid`),
    'armed GET links to the live-rank page at the exact publicSeg href, in the desk\'s own words');
  ok(/Khopoli -> Keeranur/.test(g1.text) && /Syngenta India/.test(g1.text), 'armed GET carries the load summary');
  // The rendered page's toast script embeds a client-side fallback error STRING containing
  // "Could not save" (shown only if a real AJAX failure happens, never on a plain GET) - so
  // this checks for the raw-error-PAGE wrapper specifically (<p>Could not save: ...), not a
  // bare substring, to avoid a false positive against that embedded JS text.
  ok(!/<p>Could not save:/.test(g1.text), 'armed GET has no raw error page');

  // ---- stray POST after the race (someone already armed it; NOT a re-price submit - no
  // band fields) -> falls through to the same friendly page, cost untouched ----
  const p1 = await postForm(`/price/${rA.id}`, { cost: '90000' });
  ok(p1.status === 409 && /Re-price load/.test(p1.text)
    && p1.text.includes('Rs 90,000 not saved: already priced at Rs 80,000. Use Re-price to change it.'),
  'raced form POST (no band fields) with a different cost -> the re-price page, with the dropped cost refused in words');
  ok(/id="cost"[^>]*value="80000"/.test(p1.text), 'raced form POST (no band fields) did not overwrite the captured cost');
  ok(!/<p>Could not save:/.test(p1.text), 'raced form POST carries no raw error page');
  const j1 = await postJson(`/price/${rA.id}`, { cost: 90000 });
  ok(j1.status === 409 && j1.json && /not open/.test(j1.json.error), 'JSON caller (non-band body) keeps the machine-readable 409');

  // ---- a REAL re-price submit (band fields present) rebuilds the ladder off the new band ----
  // 5% sits below the default 6.3% minimum, so the desk confirms it.
  const rp1 = await postForm(`/price/${rA.id}`, { cost: '80000', m_0: '15', m_1: '10', m_2: '5', below_min_ack: '1' });
  ok(rp1.status === 200 && /Saved/.test(rp1.text), 're-price submit -> saved confirmation on the same page');
  const rA1 = await requests.getByToken(rA.id);
  ok(rA1.marginSource === 'bid' && rA1.marginsPct[0] === 15, 're-price submit persisted as a bid-level override');
  ok(rA1.price.marginsPct[0] === 15, 're-price submit rebuilt the armed price snapshot off the new band');
  ok(rA1.price.cost === 80000, 're-price submit with an unchanged cost field leaves cost as-is');

  // ---- changing the COST itself (the actual point of re-pricing, not just margin %) ----
  const rp2 = await postForm(`/price/${rA.id}`, { cost: '72000', m_0: '15', m_1: '10', m_2: '5', below_min_ack: '1' });
  ok(rp2.status === 200 && /Saved/.test(rp2.text), 're-price submit with a new cost -> saved confirmation');
  ok(/id="cost"[^>]*value="72000"/.test(rp2.text), 're-price submit with a new cost -> the form now reflects the new cost');
  const rA1b = await requests.getByToken(rA.id);
  ok(rA1b.price.cost === 72000, 're-price submit persisted the NEW cost, not the original captured one');
  ok(rA1b.price.marginsPct[0] === 15, 're-price cost change kept the current margin band');
  // sub-Rs-1 cost is rejected the same way capture() rejects it (never silently 0 -> break-even floor)
  const rpBad = await postForm(`/price/${rA.id}`, { cost: '0', m_0: '15', m_1: '10', m_2: '5' });
  ok(rpBad.status === 400 && /Could not save/.test(rpBad.text), 're-price rejects a sub-Rs-1 cost');
  const rA1c = await requests.getByToken(rA.id);
  ok(rA1c.price.cost === 72000, 'rejected cost change did not corrupt the stored cost');

  // ---- revert -> back to the inherited band (cost is NOT "inherited" - it stays as last set) ----
  const rv1 = await postForm(`/price/${rA.id}`, { revert_override: '1' });
  ok(rv1.status === 200 && /Reverted/.test(rv1.text), 'revert submit -> reverted confirmation');
  const rA2 = await requests.getByToken(rA.id);
  ok(rA2.marginSource !== 'bid', 'revert submit cleared the bid-level override');
  ok(rA2.price.cost === 72000, 'revert submit leaves the (re-priced) cost untouched - only the band reverts');

  // ---- skipped (auction closed with no cost): GET + POST render the terminal page ----
  // expireOverdue now sweeps on the real CLOSE (deadlineAt is advisory), so the fixture is a load
  // whose auction has actually closed without a cost - the only way it becomes skipped_no_price.
  const rE = await requests.createForLoad({ ...mkLoad('PPS-2'), closesAt: now - 60_000 }, { deadlineAt: now - 90_000 });
  await requests.expireOverdue(Date.now());
  // The page must name the CUTOFF, and must not claim nothing was entered. "This request expired
  // before a cost was entered" was shown to an operator who had just typed a cost (load 23128437,
  // 2026-07-14) - a false statement about their own work, sitting next to a card that advertised
  // only the 2:45 close. The cutoff is the fact that actually explains the outcome.
  const g2 = await get(`/price/${rE.id}`);
  ok(g2.status === 200 && /Cutoff passed/.test(g2.text), 'expired GET -> cutoff page');
  ok(!/expired before a cost was entered/.test(g2.text), 'expired GET does not claim no cost was entered');
  const p2 = await postForm(`/price/${rE.id}`, { cost: '50000' });
  ok(p2.status === 200 && /Cutoff passed/.test(p2.text), 'expired POST -> same cutoff page');
  ok(!/expired before a cost was entered/.test(p2.text), 'expired POST does not claim no cost was entered');

  // ---- closed WITH an outcome in closedBids -> won/lost + our last bid ----
  const rC1 = await requests.createForLoad(mkLoad('PPS-3'), { deadlineAt: Date.now() + 60_000 });
  await store.patchDoc('priceRequests', rC1.id, { status: 'closed' });
  await store.putDoc('closedBids', 'PPS-3', { auctionId: 'PPS-3', lane: rC1.load.lane, shipper: 'Syngenta India', won: true, finalRank: 1, lastBidPrice: 84000, ourBids: [], closedAt: Date.now(), status: 'closed' });
  const g3 = await get(`/price/${rC1.id}`);
  ok(g3.status === 200 && /We won this load/.test(g3.text), 'closed GET (won) -> final outcome shown');
  ok(/Rs 84000/.test(g3.text), 'closed GET (won) -> our last bid shown');
  const p3 = await postForm(`/price/${rC1.id}`, { cost: '50000' });
  ok(p3.status === 200 && /We won this load/.test(p3.text), 'closed POST -> same outcome page');

  const rC2 = await requests.createForLoad(mkLoad('PPS-4'), { deadlineAt: Date.now() + 60_000 });
  await store.patchDoc('priceRequests', rC2.id, { status: 'closed' });
  await store.putDoc('closedBids', 'PPS-4', { auctionId: 'PPS-4', lane: rC2.load.lane, shipper: 'Syngenta India', won: false, finalRank: 3, lastBidPrice: 82000, ourBids: [], closedAt: Date.now(), status: 'closed' });
  const g4 = await get(`/price/${rC2.id}`);
  ok(g4.status === 200 && /We did not win this load/.test(g4.text) && /Final rank 3/.test(g4.text), 'closed GET (lost) -> lost + final rank');

  // ---- closed WITHOUT an outcome record -> plain "Auction ended" ----
  const rC3 = await requests.createForLoad(mkLoad('PPS-5'), { deadlineAt: Date.now() + 60_000 });
  await store.patchDoc('priceRequests', rC3.id, { status: 'closed' });
  const g5 = await get(`/price/${rC3.id}`);
  ok(g5.status === 200 && /Auction ended/.test(g5.text) && /Bidding on this load has closed/.test(g5.text), 'closed GET (no record) -> plain Auction ended');

  // ---- dismissed -> declined page ----
  const rD = await requests.createForLoad(mkLoad('PPS-6'), { deadlineAt: Date.now() + 60_000 });
  await requests.dismiss(rD.id);
  const g6 = await get(`/price/${rD.id}`);
  ok(g6.status === 200 && /declined this load/.test(g6.text), 'dismissed GET -> declined page');

  // ---- raw errors stay for genuinely unknown tokens + bad input ----
  const gU = await get('/price/zzzz-not-a-token');
  ok(gU.status === 404, 'unknown token GET -> 404');
  const jU = await postJson('/price/zzzz-not-a-token', { cost: 100 });
  ok(jU.status === 404 && jU.json && jU.json.error, 'unknown token JSON POST -> 404 JSON error');
  const rB = await requests.createForLoad(mkLoad('PPS-7'), { deadlineAt: Date.now() + 60_000 });
  const pB = await postForm(`/price/${rB.id}`, { cost: '0' });
  ok(pB.status === 400 && /Could not save/.test(pB.text), 'bad input on an OPEN request keeps the 400 error path');

  // ---- /price/:token/state: the poll source that gives the open form live awareness ----
  const rS = await requests.createForLoad(mkLoad('PPS-8'), { deadlineAt: Date.now() + 60_000 });
  const s0 = await get(`/price/${rS.id}/state`);
  ok(s0.status === 200 && s0.json && s0.json.status === 'awaiting_price', 'state: awaiting request -> status awaiting_price');
  ok(typeof (s0.json || {}).serverTime === 'number' && (s0.json || {}).closesAt && (s0.json || {}).deadlineAt,
    'state: carries serverTime + closesAt + deadlineAt (skew correction + client lock)');
  // the open form wires the poller + deadline data + submit guard, so it self-updates and
  // never lets the operator discover the race only on submit
  const gForm = await get(`/price/${rS.id}`);
  ok(/data-deadline=/.test(gForm.text), 'form: renders data-deadline for the client-side lock');
  ok(/\/state/.test(gForm.text) && /setTimeout\(poll/.test(gForm.text), 'form: polls its /state endpoint on a timer');
  ok(/Saving\.\.\./.test(gForm.text), 'form: disables the submit button on tap (double-submit guard)');
  // once someone prices it, /state flips to armed -> an open form sees it and swaps itself
  await postForm(`/price/${rS.id}`, { cost: '77000' });
  const s1 = await get(`/price/${rS.id}/state`);
  ok(s1.status === 200 && s1.json && s1.json.status === 'armed', 'state: after capture -> armed (drives the open form to swap, no submit)');
  const sU = await get('/price/zzzz-not-a-token/state');
  ok(sU.status === 404 && sU.json && sU.json.error, 'state: unknown token -> 404 JSON error, never a page');

  server.close();

  // COMPLETION SENTINEL. run-tests.js grades a file by EXIT STATUS only, so a file that returns
  // early - an unref'd timer, an early return, a swallowed rejection - exits 0 having asserted
  // nothing and is scored a pass. Pinning the count makes a vacuous green impossible.
  const EXPECTED_CHECKS = 47;
  const ran = pass + fail;
  if (ran !== EXPECTED_CHECKS) {
    console.error(`  FAIL - completion sentinel: ran ${ran} checks, expected ${EXPECTED_CHECKS} (a check was skipped or added without updating EXPECTED_CHECKS)`);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  console.log(`\n${pass} passed, ${fail} failed (${ran}/${EXPECTED_CHECKS} checks reached the sentinel)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
