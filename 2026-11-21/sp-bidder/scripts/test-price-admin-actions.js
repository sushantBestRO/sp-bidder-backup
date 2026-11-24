'use strict';
/**
 * The public /price/:token dead-end pages (stopped / dismissed) now carry an admin-gated
 * action bar instead of leaving the pricing team stuck. Boots with a real admin hash (the
 * auth-off dev path can never exercise the "not signed in" branch) and drives both sides:
 * signed out -> a "log in to manage" link, never the raw action button; signed in -> the
 * button actually calls the same /api endpoint the console uses and flips state for real.
 * Also covers the rearm-eligible vs already-past-closesAt "stopped" split, and confirms the
 * armed/reprice surface is untouched (no admin bar - that page was already self-service).
 */
const { hashPassword } = require('../src/auth/adminAuth');

process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_ADMIN_USER = 'admin';
process.env.SP_ADMIN_PASS_HASH = hashPassword('testpass');
process.env.SP_SESSION_SECRET = 'unit-test-secret-do-not-ship';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-price-admin-'));

const http = require('http');
const { app, requests, stacks } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

function req(method, url, { body = null, contentType = null, cookie = null, origin = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType || 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json, setCookie: res.headers['set-cookie'] || [] }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const cookieFrom = (arr) => { for (const c of arr) { const m = /^sp_session=([^;]*)/.exec(c); if (m) return `sp_session=${m[1]}`; } return null; };

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = base;
  const get = (p, opts) => req('GET', base + p, opts);
  const post = (p, obj, opts) => req('POST', base + p, { body: JSON.stringify(obj || {}), origin, ...opts });

  const login = await req('POST', base + '/api/login', { body: JSON.stringify({ user: 'admin', password: 'testpass' }), origin });
  const adminCookie = cookieFrom(login.setCookie);
  ok(!!adminCookie, 'login succeeds and issues a session cookie');

  const now = Date.now();
  const mkLoad = (id, closesInMs) => ({
    id, lane: { origin: 'Bhiwandi', destination: 'Bawal' }, equipment: 'Trailer', units: 1,
    companyName: 'Syngenta India', closesAt: now + closesInMs, startsAt: now - 60_000,
    softClose: false, status: 'live',
  });

  // ---- dismissed: signed out sees a pointer, signed in sees a working Restore ----
  const rD = await requests.createForLoad(mkLoad('ADM-1', 20 * 60_000));
  await requests.dismiss(rD.id);
  const dOut = await get(`/price/${rD.id}`);
  ok(dOut.status === 200 && /Request closed/.test(dOut.text), 'dismissed -> the terminal page renders');
  ok(/Need to resume or restore this\?/.test(dOut.text) && /admin_return=/.test(dOut.text), 'dismissed, signed OUT -> a login pointer, not an action button');
  ok(!/id="abtn"/.test(dOut.text), 'dismissed, signed OUT -> no live action button in the markup');
  const dIn = await get(`/price/${rD.id}`, { cookie: adminCookie });
  ok(/id="abtn"/.test(dIn.text) && /Restore this request/.test(dIn.text), 'dismissed, signed IN -> a working Restore button');
  const restoreRes = await post(`/api/price-requests/${rD.id}/restore`, {}, { cookie: adminCookie });
  ok(restoreRes.status === 200 && restoreRes.json.ok, 'Restore endpoint succeeds for an admin session');
  const rD2 = await requests.getByToken(rD.id);
  ok(rD2.status === 'awaiting_price', 'restore actually flips the request back to awaiting_price');
  const dRestored = await get(`/price/${rD.id}`, { cookie: adminCookie });
  ok(/Enter your rate/.test(dRestored.text), 'after restore, the SAME link renders the live rate-entry form again');
  ok(/Decline this request/.test(dRestored.text), 'the restored awaiting_price form carries the Decline admin action');

  // ---- restore without a session is refused (the admin API gate, unchanged by this feature) ----
  const rD3 = await requests.createForLoad(mkLoad('ADM-1b', 20 * 60_000));
  await requests.dismiss(rD3.id);
  const restoreNoAuth = await post(`/api/price-requests/${rD3.id}/restore`, {});
  ok(restoreNoAuth.status === 401, 'restore without a session -> 401 (no new gate needed, existing /api guard covers it)');

  // ---- dismissed past its own closesAt: no Restore button offered (would 410 GONE) ----
  const rD4 = await requests.createForLoad(mkLoad('ADM-1c', 3_000));
  await requests.dismiss(rD4.id);
  await new Promise((r) => setTimeout(r, 3100)); // let closesAt lapse
  const dLapsed = await get(`/price/${rD4.id}`, { cookie: adminCookie });
  ok(!/id="abtn"/.test(dLapsed.text), 'dismissed + closesAt already passed -> no Restore button offered (would 410 GONE)');
  const restoreLapsed = await post(`/api/price-requests/${rD4.id}/restore`, {}, { cookie: adminCookie });
  ok(restoreLapsed.status === 410, 'restore on a lapsed dismissed load is still refused server-side (GONE) even if called directly');

  // ---- stopped, still within its window: signed in Reopen actually resumes bidding ----
  const rS = await requests.createForLoad(mkLoad('ADM-2', 20 * 60_000));
  await requests.capture(rS.id, { cost: 80000 });
  await requests.stop(rS.id);
  const sOut = await get(`/price/${rS.id}`);
  ok(sOut.status === 200 && /Bidding paused/.test(sOut.text), 'stopped (still open) -> "Bidding paused", not the old generic dead-end copy');
  ok(/Need to resume or restore this\?/.test(sOut.text), 'stopped, signed OUT -> a login pointer');
  const sIn = await get(`/price/${rS.id}`, { cookie: adminCookie });
  ok(/Reopen and resume bidding/.test(sIn.text), 'stopped, signed IN -> a working Reopen button');
  const rearmRes = await post(`/api/auctions/${rS.loadId}/rearm`, {}, { cookie: adminCookie });
  ok(rearmRes.status === 200 && rearmRes.json.ok, 'Reopen (rearm) endpoint succeeds for an admin session');
  const rS2 = await requests.getByToken(rS.id);
  ok(rS2.status === 'armed', 'reopen actually flips the request back to armed');
  const sReopened = await get(`/price/${rS.id}`, { cookie: adminCookie });
  ok(/Re-price load/.test(sReopened.text), 'after reopen, the SAME link renders the self-service re-price form (armed surface untouched)');
  ok(!/id="abtn"/.test(sReopened.text), 'the armed/re-price page has NO admin action bar - that surface was already self-service, out of scope for this change');

  // ---- stopped past its own closesAt: permanently-closed messaging, no button offered ----
  // closesAt lapses in 5s (that IS the case under test), so the 90s-lead deadline createForLoad
  // would derive sits in the past and capture() would refuse it. Hold the pricing window open:
  // this test is about the page an armed load shows AFTER its auction ends, not about the cutoff.
  const rL = await requests.createForLoad(mkLoad('ADM-3', 5_000), { deadlineAt: Date.now() + 60_000 });
  await requests.capture(rL.id, { cost: 80000 });
  await requests.stop(rL.id);
  await new Promise((r) => setTimeout(r, 5100)); // let closesAt lapse
  const lOut = await get(`/price/${rL.id}`, { cookie: adminCookie });
  ok(/Auction ended/.test(lOut.text), 'stopped + closesAt already passed -> permanently-closed copy, matching the closed-state page');
  ok(!/Reopen and resume bidding/.test(lOut.text), 'lapsed stopped -> no Reopen button offered (would 410 GONE if clicked)');
  const rearmLapsed = await post(`/api/auctions/${rL.loadId}/rearm`, {}, { cookie: adminCookie });
  ok(rearmLapsed.status === 410, 'rearm on a lapsed stopped load is still refused server-side (GONE) even if called directly');

  // ---- a PLACEHOLDER close (SP's year-2100 filler) gets its OWN page, and no doomed Restore ----
  // capture()/restore() refuse these with NO_VALID_CLOSE, never GONE, and the codes are not
  // interchangeable at the render: the GONE page tells the operator their cost "reached us after
  // this auction closed", which on a load that has NOT closed is false - and it would render
  // directly above a summary card showing the 2100 date.
  const rP = await requests.createForLoad(mkLoad('ADM-4', Date.parse('2100-05-24T19:53:25.000Z') - now));
  const pPost = await req('POST', `${base}/price/${rP.id}`, { origin,
    body: new URLSearchParams({ cost: '15000' }).toString(), contentType: 'application/x-www-form-urlencoded' });
  ok(pPost.status === 410, 'a cost on a placeholder-close load is refused (410)');
  ok(/no bidding deadline/i.test(pPost.text), 'and gets its own page, naming the missing deadline');
  ok(!/after this auction closed/.test(pPost.text), 'never the closed-auction copy - that sentence would be false here');
  const rP2 = await requests.getByToken(rP.id);
  ok(rP2.status === 'awaiting_price' && !rP2.price, 'and the cost was genuinely not saved');

  // dismissed + placeholder: restore() can never succeed on it, so the button must not be offered.
  // Unlike a lapsed close this never resolves itself - finalizeClosed does not sweep 'dismissed'.
  await requests.dismiss(rP.id);
  const pDis = await get(`/price/${rP.id}`, { cookie: adminCookie });
  ok(!/id="abtn"/.test(pDis.text), 'dismissed + placeholder close -> no Restore button offered (would 410)');
  const pRestore = await post(`/api/price-requests/${rP.id}/restore`, {}, { cookie: adminCookie });
  ok(pRestore.status === 410, 'restore on a placeholder row is still refused server-side if called directly');

  // ---- re-arm a HELD row while the portal still cannot bid: the reason must survive the rollback ----
  // rearm() nulls heldReason before armFromRequest runs and the rollback cannot write one back, so
  // a row parked by the system would return as an operator pause no operator made.
  const rHB = await requests.createForLoad(mkLoad('ADM-5', 20 * 60_000));
  await requests.capture(rHB.id, { cost: 80000 });
  await requests.holdUnbiddable(rHB.id, 'platform_bidding_disabled');
  const stack = stacks[0];
  const capsBefore = stack.engine.caps;
  stack.engine.caps = Object.assign({}, capsBefore, { biddingEnabled: false });
  try {
    const rearmHeld = await post(`/api/auctions/${rHB.loadId}/rearm`, {}, { cookie: adminCookie });
    ok(rearmHeld.status === 409, 're-arm against a still-disabled portal is refused 409, not a 500');
    const rHB2 = await requests.getByToken(rHB.id);
    ok(rHB2.status === 'stopped', 'the refused re-arm rolls the row back to stopped');
    ok(rHB2.heldReason === 'platform_bidding_disabled', 'and the hold reason survives the rollback - not an operator pause nobody made');
  } finally {
    stack.engine.caps = capsBefore;
  }

  // ---- unknown token: a branded page, not a bare text 404 ----
  const bad = await get('/price/does-not-exist');
  ok(bad.status === 404 && /class="card"/.test(bad.text) && /Unknown or expired link/.test(bad.text), 'unknown token -> a styled 404 page, not a raw text response');
  const badTrack = await get('/track/does-not-exist');
  ok(badTrack.status === 404 && /class="card"/.test(badTrack.text), '/track unknown token -> a styled 404 page too');

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
