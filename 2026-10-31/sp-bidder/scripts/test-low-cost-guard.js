'use strict';
/**
 * Soft low-cost guard on the public /price capture + re-price submit.
 *
 * A fat-fingered cost (a Rs 2 typed for a ~Rs 22,000 load - load 23189088, 2026-07-16) armed cleanly,
 * because capture()'s only floor was Rs >= 1 and the floor invariant only stops the bot bidding BELOW
 * the number entered - it can't tell an absurd cost from a real one, so the bot would have bid ~Rs 2.
 * The POST handler now rejects an implausibly low cost (< config.minPlausibleCost) UNLESS the submit
 * carries low_cost_ack, the flag the form's confirm dialog sets. Soft (the desk confirms through it)
 * and server-side (holds even if the page JS dies / a raw curl hits the token). This pins both entry
 * points: the first capture and a re-price of an already-armed load.
 *
 * SCOPE NOTE (desk clerical-error floor, 2026-07-25): a second, HARD band now sits at this same seam
 * (SP_MIN_COST_ABS / SP_MIN_COST_PER_KM - see scripts/test-desk-cost-floor.js). On a TRUCK-basis load
 * the shipped hard floor (Rs 5,000) supersedes this soft one (Rs 500) and the confirm-through path is
 * unreachable there, so the behaviour pinned BELOW is the legacy contract that survives on a truck
 * load only when the hard band is switched off. It is NOT switched off on a PMT load: the hard band
 * carves PMT out entirely, so on a per-tonne load this soft guard is live under the shipped defaults
 * and is the only cost guard there is. The two hard knobs are therefore zeroed here deliberately: this file
 * keeps testing exactly what it always tested (the soft guard in isolation, coverage unchanged), and
 * test-desk-cost-floor.js owns the hard band plus the interaction between them. Zeroing them is the
 * fail-safe direction's own regression pin - with both knobs 0 the seam must behave byte-identically
 * to the pre-hard-floor build, which is precisely what these assertions verify.
 *
 *   node scripts/test-low-cost-guard.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';        // this test is about the cost guard, not close-scope
process.env.SP_NOTIFY_MODE = 'dashboard';    // no WhatsApp send in a unit test
process.env.SP_MIN_PLAUSIBLE_COST = '500';   // pin the threshold this test asserts against
process.env.SP_MIN_COST_ABS = '0';           // hard clerical-error band OFF - see SCOPE NOTE above
process.env.SP_MIN_COST_PER_KM = '0';        // (both terms off = the legacy soft-only behaviour)

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-low-cost-'));

const http = require('http');
const { app, requests } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

function req(method, url, { body = null, contentType = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType || 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const json = (obj) => JSON.stringify(obj);

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now();
  const mkLoad = (id) => ({
    id, lane: { origin: 'Govindgarh', destination: 'Vadodara' }, equipment: 'Dala Body LPT 14Ft', units: 1,
    companyName: 'Waaree', closesAt: now + 20 * 60_000, startsAt: now - 60_000,
    softClose: false, closeModelKnown: true, status: 'live',
  });

  // ---- first capture: a Rs 2 cost is rejected without the confirm flag ----
  {
    const r = await requests.createForLoad(mkLoad('LOW-1'));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '2' }) });
    ok(res.status === 400 && /low/i.test(res.text), 'first capture: Rs 2 without low_cost_ack -> 400 (rejected)');
    const still = await requests.getByToken(r.id);
    ok(still.status === 'awaiting_price' && still.price == null, 'first capture: the rejected Rs 2 did NOT arm the load');
  }

  // ---- first capture: a low cost goes through WITH the confirm flag (soft, not a hard block) ----
  // Rs 20, not Rs 2: at Rs 2 every margin rounds the floor rung onto the cost itself, which is refused
  // as a bid at cost whatever the acknowledgement (A006). Rs 20 is still under the plausibility floor.
  {
    const r = await requests.createForLoad(mkLoad('LOW-2'));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '20', low_cost_ack: '1' }) });
    ok(res.status === 200, 'first capture: Rs 20 WITH low_cost_ack -> accepted');
    const armed = await requests.getByToken(r.id);
    ok(armed.status === 'armed' && armed.price && armed.price.cost === 20, 'first capture: the confirmed Rs 20 armed the load');
  }

  // ---- first capture: a normal cost needs no confirmation ----
  {
    const r = await requests.createForLoad(mkLoad('LOW-3'));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '22000' }) });
    ok(res.status === 200, 'first capture: a normal Rs 22,000 needs no confirm flag');
    const armed = await requests.getByToken(r.id);
    ok(armed.status === 'armed' && armed.price && armed.price.cost === 22000, 'first capture: the normal cost armed the load');
  }

  // ---- re-price: an armed load re-priced to Rs 2 is guarded the same way ----
  {
    const r = await requests.createForLoad(mkLoad('LOW-4'));
    const arm = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '22000' }) }); // arm at a real rate
    ok(arm.status === 200, 're-price setup: the load armed at Rs 22,000');
    // the re-price form posts the band (m_0..) + cost; JSON path here for a clean status/error assert
    const band = { m_0: '12.6', m_1: '7.2', m_2: '6.3' };
    const bad = await req('POST', `${base}/price/${r.id}`, { body: json({ cost: '2', ...band }), contentType: 'application/json' });
    ok(bad.status === 400 && /low/i.test((bad.json && bad.json.error) || bad.text), 're-price: Rs 2 without low_cost_ack -> 400 (rejected)');
    const afterBad = await requests.getByToken(r.id);
    ok(afterBad.price && afterBad.price.cost === 22000, 're-price: the rejected Rs 2 left the armed Rs 22,000 in place');
    const good = await req('POST', `${base}/price/${r.id}`, { body: json({ cost: '20', low_cost_ack: '1', ...band }), contentType: 'application/json' });
    ok(good.status === 200, 're-price: Rs 20 WITH low_cost_ack -> accepted');
    const afterGood = await requests.getByToken(r.id);
    ok(afterGood.price && afterGood.price.cost === 20, 're-price: the confirmed Rs 20 re-priced the load');
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
