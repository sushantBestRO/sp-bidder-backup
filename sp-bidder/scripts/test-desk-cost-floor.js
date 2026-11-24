'use strict';
/**
 * DESK CLERICAL-ERROR COST FLOOR - the hard band on the public /price capture + re-price submit.
 *
 * The failure this exists to stop (named by the client on the 2026-07-25 training call): a desk
 * member types 1,500 for a load they meant to price at 15,000. The bot then bids off a cost an order
 * of magnitude below the real one and wins at a catastrophic loss. The pre-existing soft guard
 * (SP_MIN_PLAUSIBLE_COST, Rs 500) cannot catch that: 1,500 clears it, and even below it the desk can
 * confirm through. A missing digit lands on a number that still LOOKS plausible, so a confirm dialog
 * is the wrong instrument - it just gets clicked.
 *
 * Two bands, one code path (LOW_COST -> 400), hard checked first:
 *   HARD  cost < max(SP_MIN_COST_ABS, SP_MIN_COST_PER_KM x km)  -> 400, NO ack bypass. TRUCK basis only.
 *   SOFT  cost < SP_MIN_PLAUSIBLE_COST                          -> 400 unless low_cost_ack (legacy).
 * With the shipped defaults (hard 5000 > soft 500) the soft band is unreachable ON A TRUCK LOAD; it
 * survives there only for an operator who deliberately zeroes both hard knobs, which restores the
 * exact legacy behaviour. On a PMT load the hard band carves out before any comparison, so the soft
 * band is live and is the only guard - pinned in Part 6 below.
 *
 * The per-km term uses SuperProcure's OWN route distance (load.distanceKm <- loadDistance), never an
 * estimate. No distance -> the absolute floor stands alone.
 *
 *   node scripts/test-desk-cost-floor.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';        // this test is about the cost floor, not close-scope
process.env.SP_NOTIFY_MODE = 'dashboard';    // no WhatsApp send in a unit test
process.env.SP_MIN_PLAUSIBLE_COST = '500';   // pin the legacy soft threshold
process.env.SP_MIN_COST_ABS = '5000';        // pin the hard absolute floor this test asserts against
process.env.SP_MIN_COST_PER_KM = '10';       // pin the per-km rate

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-desk-floor-'));

const http = require('http');
const { spawnSync } = require('child_process');
const { app, requests, store, hardCostFloorFor, costFloorBootLine } = require('../src/web/server');
// The redaction assertions below pin the record against the SHARED helper rather than a hand-copied
// 6-char slice, so tightening redactToken cannot leave this test asserting the old shape.
const { redactToken } = require('../src/util/redactToken');

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
const BAND = { m_0: '12.6', m_1: '7.2', m_2: '6.3' };

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now();
  // TRUCK-basis load (quoteType FTL), no distance on the wire -> absolute floor only.
  const mkLoad = (id, over = {}) => ({
    id, lane: { origin: 'Govindgarh', destination: 'Vadodara' }, equipment: 'Dala Body LPT 14Ft', units: 1,
    quoteType: 'FTL', companyName: 'Waaree', closesAt: now + 20 * 60_000, startsAt: now - 60_000,
    softClose: false, closeModelKnown: true, status: 'live', ...over,
  });

  console.log('\n1. HARD band - a missing digit is refused outright (the 2026-07-25 commitment)');

  // The literal failure from the call: 1,500 typed for a load meant to be 15,000. Clears the legacy
  // soft floor (1500 > 500), so ONLY the hard band catches it.
  {
    const r = await requests.createForLoad(mkLoad('DF-1'));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '1500' }) });
    ok(res.status === 400, 'capture: Rs 1,500 (meant 15,000) -> 400 rejected');
    ok(/too low for this load/i.test(res.text), 'capture: the refusal says the rate looks too low for this load');
    ok(/missing digit/i.test(res.text), 'capture: the message tells the desk to check for a missing digit');
    ok(/1,500/.test(res.text) && /5,000/.test(res.text), 'capture: the message names BOTH numbers (entered 1,500 and the Rs 5,000 floor)');
    const still = await requests.getByToken(r.id);
    ok(still.status === 'awaiting_price' && still.price == null, 'capture: the rejected 1,500 did NOT arm the load');
  }

  // No "bot" wording may reach the desk (house rule for every /price page string).
  {
    const r = await requests.createForLoad(mkLoad('DF-1b'));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '4500' }) });
    ok(!/\bbot\b/i.test(res.text), 'capture: the refusal never uses the word "bot"');
  }

  console.log('\n2. HARD band - the ack CANNOT bypass it (the soft confirm is not a skeleton key)');

  {
    const r = await requests.createForLoad(mkLoad('DF-2'));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '1500', low_cost_ack: '1' }) });
    ok(res.status === 400 && /too low for this load/i.test(res.text),
      'capture: Rs 1,500 WITH low_cost_ack is STILL rejected (hard band ignores the ack)');
    const still = await requests.getByToken(r.id);
    ok(still.status === 'awaiting_price' && still.price == null, 'capture: the acked 1,500 did NOT arm the load');
  }

  // ...and the legacy Rs 2 case, which used to be confirm-through, is now hard-refused under defaults.
  {
    const r = await requests.createForLoad(mkLoad('DF-2b'));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '2', low_cost_ack: '1' }) });
    ok(res.status === 400, 'capture: with the hard floor on, an acked Rs 2 no longer arms (hard supersedes soft)');
  }

  console.log('\n3. at/above the floor is accepted (the guard must not eat the happy path)');

  {
    const r = await requests.createForLoad(mkLoad('DF-3'));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '5000' }) });
    ok(res.status === 200, 'capture: exactly Rs 5,000 (at the floor) is ACCEPTED - the floor is inclusive');
    const armed = await requests.getByToken(r.id);
    ok(armed.status === 'armed' && armed.price.cost === 5000, 'capture: the at-floor cost armed the load');
  }
  {
    const r = await requests.createForLoad(mkLoad('DF-3b'));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '22000' }) });
    ok(res.status === 200, 'capture: a normal Rs 22,000 is accepted');
  }

  console.log('\n4. per-km term binds when a real distance exists and exceeds the absolute floor');

  // 620 km x Rs 10 = Rs 6,200, which is ABOVE the Rs 5,000 absolute. A cost of 5,500 clears the
  // absolute but must fail the per-km floor - this is the case the km term exists for.
  {
    const r = await requests.createForLoad(mkLoad('DF-4', { distanceKm: 620 }));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '5500' }) });
    ok(res.status === 400, 'capture: Rs 5,500 on a 620 km lane -> 400 (per-km floor 6,200 binds over the 5,000 absolute)');
    ok(/6,200/.test(res.text), 'capture: the message names the computed per-km floor (Rs 6,200)');
    ok(/10\/km/.test(res.text) && /620 km/.test(res.text), 'capture: the message shows the arithmetic (Rs 10/km x 620 km)');
  }
  {
    const r = await requests.createForLoad(mkLoad('DF-4b', { distanceKm: 620 }));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '6200' }) });
    ok(res.status === 200, 'capture: exactly Rs 6,200 on the 620 km lane is accepted (at the per-km floor)');
  }
  // A SHORT lane: 100 km x Rs 10 = Rs 1,000, BELOW the absolute. max() must keep the Rs 5,000 floor.
  {
    const r = await requests.createForLoad(mkLoad('DF-4c', { distanceKm: 100 }));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '1200' }) });
    ok(res.status === 400 && /5,000/.test(res.text),
      'capture: on a 100 km lane the ABSOLUTE 5,000 still governs (max of the two, not the km term alone)');
  }

  console.log('\n5. no distance on the load -> absolute floor only (never a fabricated km)');

  {
    const r = await requests.createForLoad(mkLoad('DF-5')); // no distanceKm
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '4999' }) });
    ok(res.status === 400 && /5,000/.test(res.text), 'capture: no distance -> the Rs 5,000 absolute floor applies');
    ok(!/\/km/.test(res.text), 'capture: no distance -> the message does NOT claim a per-km computation');
  }
  // Junk / zero distance must not produce a Rs 0 floor or a NaN comparison that disables the guard.
  for (const [label, km] of [['null', null], ['zero', 0], ['junk', 'abc']]) {
    const r = await requests.createForLoad(mkLoad(`DF-5-${label}`, { distanceKm: km }));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '4999' }) });
    ok(res.status === 400, `capture: distanceKm=${label} still enforces the absolute floor (no NaN fail-open)`);
  }

  console.log('\n6. PMT basis is carved out - a per-tonne rate is legitimately small');

  // On a PMT load `units` is the TONNAGE and the cost is PER METRIC TONNE: Rs 800/MT is a real rate,
  // so the absolute rupee floor must not touch it. Only the legacy soft confirm applies there.
  {
    const r = await requests.createForLoad(mkLoad('DF-6', { quoteType: 'PMT', units: 22 }));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '800' }) });
    ok(res.status === 200, 'capture: a PMT load accepts Rs 800/MT (below the absolute floor) - carve-out holds');
    const armed = await requests.getByToken(r.id);
    ok(armed.status === 'armed' && armed.price.cost === 800, 'capture: the PMT per-tonne cost armed the load');
  }
  // PMT still keeps the LEGACY soft guard: below Rs 500 needs the confirm, and the ack works there.
  {
    const r = await requests.createForLoad(mkLoad('DF-6b', { quoteType: 'PMT', units: 22 }));
    // Rs 20, not Rs 2: at Rs 2 every margin rounds the floor rung onto the cost itself, which is
    // refused as a bid at cost whatever the acknowledgement (A006). Rs 20 is still under Rs 500.
    const bad = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '20' }) });
    ok(bad.status === 400, 'capture: a PMT load still gets the SOFT guard below Rs 500 (Rs 20 rejected unconfirmed)');
    const good = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '20', low_cost_ack: '1' }) });
    ok(good.status === 200, 'capture: on PMT the soft ack still works (confirm-through preserved)');
  }
  // A PMT distance must not resurrect the per-km floor either.
  {
    const r = await requests.createForLoad(mkLoad('DF-6c', { quoteType: 'PMT', units: 22, distanceKm: 620 }));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '800' }) });
    ok(res.status === 200, 'capture: a PMT load with a real distance still bypasses the per-km floor');
  }

  console.log('\n7. unknown basis is treated as TRUCK (conservative direction for a too-low cost)');

  {
    const r = await requests.createForLoad(mkLoad('DF-7', { quoteType: null }));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '1500' }) });
    ok(res.status === 400, 'capture: a load with NO recorded basis is guarded (unknown -> truck, guard ON)');
  }

  console.log('\n8. re-price is guarded identically to capture (same seam, same numbers)');

  {
    const r = await requests.createForLoad(mkLoad('DF-8'));
    const arm = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '22000' }) });
    ok(arm.status === 200, 're-price setup: armed at Rs 22,000');

    const bad = await req('POST', `${base}/price/${r.id}`, { body: json({ cost: '1500', ...BAND }), contentType: 'application/json' });
    ok(bad.status === 400 && /too low for this load/i.test((bad.json && bad.json.error) || bad.text),
      're-price: Rs 1,500 -> 400 with the same clerical-error message');
    const afterBad = await requests.getByToken(r.id);
    ok(afterBad.price.cost === 22000, 're-price: the rejected 1,500 left the armed Rs 22,000 intact');

    const acked = await req('POST', `${base}/price/${r.id}`, { body: json({ cost: '1500', low_cost_ack: '1', ...BAND }), contentType: 'application/json' });
    ok(acked.status === 400, 're-price: the ack does NOT bypass the hard band either');
    const afterAck = await requests.getByToken(r.id);
    ok(afterAck.price.cost === 22000, 're-price: the acked 1,500 still left Rs 22,000 intact');

    const good = await req('POST', `${base}/price/${r.id}`, { body: json({ cost: '18000', ...BAND }), contentType: 'application/json' });
    ok(good.status === 200, 're-price: a legitimate Rs 18,000 re-price still goes through');
    const afterGood = await requests.getByToken(r.id);
    ok(afterGood.price.cost === 18000, 're-price: the legitimate cost was stored');
  }

  // A revert carries no cost in the body and must never be blocked by a cost guard.
  {
    const r = await requests.createForLoad(mkLoad('DF-8b'));
    await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '22000' }) });
    await req('POST', `${base}/price/${r.id}`, { body: json({ cost: '22000', m_0: '15', m_1: '10', m_2: '5' }), contentType: 'application/json' });
    const rev = await req('POST', `${base}/price/${r.id}`, { body: json({ revert_override: '1' }), contentType: 'application/json' });
    ok(rev.status === 200, 're-price: a margin REVERT (no cost in the body) is not blocked by the floor');
  }

  console.log('\n9. the page mirrors the same floor (server-rendered, no second source of truth)');

  {
    const r = await requests.createForLoad(mkLoad('DF-9', { distanceKm: 620 }));
    const page = await req('GET', `${base}/price/${r.id}`);
    ok(/var HARDFLOOR=6200/.test(page.text), 'page: the 620 km load inlines HARDFLOOR=6200 (matches the server)');
    ok(/function hardFloorOk\(\)/.test(page.text), 'page: ships the hard-floor gate function');
  }
  {
    const r = await requests.createForLoad(mkLoad('DF-9b', { quoteType: 'PMT', units: 22 }));
    const page = await req('GET', `${base}/price/${r.id}`);
    ok(/var HARDFLOOR=0/.test(page.text), 'page: a PMT load inlines HARDFLOOR=0 (client mirrors the carve-out)');
  }

  console.log('\n10. FRACTIONAL lane distance - the quoted minimum is a number the desk can actually type');

  // SuperProcure's loadDistance is fractional in real data (1894.24 km on the Alwar->Kamrup/Havells
  // lane; 235.58 km on a live _mapLoad capture). An unrounded floor of 18,942.4 breaks three surfaces
  // at once: it is QUOTED as "Rs 18,942" (fmtRs is 0 dp) and then refused again when the desk types
  // exactly that, its stated arithmetic does not multiply out, and the inlined HARDFLOOR carries a
  // decimal the step="1" cost input rejects. The floor must be one whole rupee everywhere.
  {
    const r = await requests.createForLoad(mkLoad('DF-10', { distanceKm: 1894.24 }));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '1500' }) });
    ok(res.status === 400, 'fractional km: Rs 1,500 on a 1894.24 km lane is refused');

    const m = /minimum for this load is Rs ([\d,]+) \(Rs ([\d,.]+)\/km x ([\d,]+) km\)/.exec(res.text);
    ok(!!m, 'fractional km: the refusal states the floor AND the per-km arithmetic behind it');
    const unc = (s) => Number(String(s).replace(/,/g, ''));
    const quotedFloor = m ? unc(m[1]) : NaN, quotedRate = m ? unc(m[2]) : NaN, quotedKm = m ? unc(m[3]) : NaN;

    // The bug this pins: the message used to print "Rs 10/km x 1,894 km" beside a floor of 18,942 -
    // 10 x 1,894 = 18,940, so the arithmetic the desk is shown did not produce the number beside it.
    ok(quotedRate * quotedKm === quotedFloor,
      `fractional km: the shown arithmetic multiplies out (${quotedRate} x ${quotedKm} = ${quotedFloor})`);
    ok(Number.isInteger(quotedFloor), 'fractional km: the quoted floor is a whole rupee, not 18,942.4');

    // The heart of it: whatever number the refusal names, typing THAT number must be accepted. It was
    // not - fmtRs rounded 18,942.4 down to "Rs 18,942" and `c >= f.floor` then refused 18,942 with the
    // identical message, leaving the desk with no way to find the value that works.
    const retry = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: String(quotedFloor) }) });
    ok(retry.status === 200, 'fractional km: re-submitting the QUOTED minimum verbatim is ACCEPTED');
    const armed = await requests.getByToken(r.id);
    ok(armed.status === 'armed' && armed.price.cost === quotedFloor,
      'fractional km: the quoted minimum armed the load at exactly that cost');

    // Ceil, never floor/round: rounding a money guard must only ever move it UP. 1894.24 -> 1895 km.
    const f = hardCostFloorFor({ distanceKm: 1894.24 });
    ok(f.km === 1895 && f.byKm === 18950 && f.floor === 18950,
      'fractional km: the lane rounds UP (1894.24 -> 1895 km -> Rs 18,950), never down');
  }
  // The page's inlined mirror must be the SAME integer - a decimal there is silently rejected by the
  // step="1" cost input, so the desk cannot submit the very number the page is demanding.
  {
    const r = await requests.createForLoad(mkLoad('DF-10b', { distanceKm: 1894.24 }));
    const page = await req('GET', `${base}/price/${r.id}`);
    ok(/var HARDFLOOR=18950;/.test(page.text), 'fractional km: the page inlines HARDFLOOR=18950 (integer, matches the server)');
    ok(!/var HARDFLOOR=[\d]+\.[\d]/.test(page.text), 'fractional km: the inlined HARDFLOOR carries no decimal');
  }
  // A fractional SHORT lane: 235.58 km -> 2,360 by km, under the 5,000 absolute, so the absolute wins
  // and the message must NOT claim a per-km computation it did not use.
  {
    const r = await requests.createForLoad(mkLoad('DF-10c', { distanceKm: 235.58 }));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '1500' }) });
    ok(res.status === 400 && /5,000/.test(res.text) && !/\/km/.test(res.text),
      'fractional km: a short fractional lane falls back to the absolute floor with no per-km claim');
  }

  console.log('\n11. every refusal leaves a record (it is otherwise the one money decision with no artifact)');

  {
    const before = (await store.readEvents('costFloorRefused')).length;
    const r = await requests.createForLoad(mkLoad('DF-11', { distanceKm: 620 }));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '1500' }) });
    ok(res.status === 400, 'observability setup: the refusal fired');

    const evs = await store.readEvents('costFloorRefused');
    ok(evs.length === before + 1, 'refusal: exactly one costFloorRefused event was appended');
    const e = evs[evs.length - 1];
    ok(e && e.loadId === 'DF-11', 'refusal event: names the load');
    ok(e && e.entered === 1500 && e.floor === 6200, 'refusal event: carries the entered cost AND the effective floor');
    ok(e && e.boundBy === 'perKm' && e.km === 620, 'refusal event: says WHICH term bound (perKm on a 620 km lane)');
    // Two seams write this stream now (the /price submit and the console margin re-price), so a bare
    // count cannot tell a mistyped knob from one operator forcing low costs through the console.
    ok(e && e.source === 'price-submit', 'refusal event: names the SEAM that refused');
    ok(e && e.actor === 'pricing', 'refusal event: attributes the anonymous /price seam to its own audit-trail label');

    // The same line has to reach a human reading pm2 logs / the console feed, not just the stream.
    const state = await req('GET', `${base}/api/state`);
    const msgs = ((state.json && state.json.events) || []).map((x) => String(x.msg || ''));
    ok(msgs.some((s) => /cost floor REFUSED/.test(s) && /DF-11/.test(s) && /6200/.test(s)),
      'refusal: a warn line naming the load, the entered cost and the floor reaches the log feed');
    ok(msgs.some((s) => /cost floor REFUSED/.test(s) && /price-submit/.test(s)),
      'refusal: the warn line names the seam too, not just the stored record');
  }
  // SECURITY: the capability token must never land in this record whole. reqDoc.id IS the auth for the
  // public /price/<token> page - holding it is enough to re-price a live auction with no session - and
  // this stream is appended to DISK under data/logs and rides into backups, so "it's only a log line"
  // is not a reason to keep it. Asserted against the SERIALIZED record, not one named field, so a
  // future field that re-adds the token whole fails here too.
  {
    const r = await requests.createForLoad(mkLoad('DF-11d', { distanceKm: 620 }));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '1500' }) });
    ok(res.status === 400, 'redaction setup: the refusal fired');
    const evs = await store.readEvents('costFloorRefused');
    const e = evs[evs.length - 1];
    ok(e && e.loadId === 'DF-11d', 'redaction setup: the record under test is the one just written');
    ok(!JSON.stringify(e).includes(r.id),
      'refusal event: the FULL capability token appears NOWHERE in the stored record');
    ok(e && e.requestId === redactToken(r.id),
      'refusal event: requestId is the redactToken() prefix - the same idiom every other token sink uses');
    ok(e && e.requestId !== r.id, 'refusal event: requestId is not the raw token');
    // loadId is the key anyone actually correlates these by, so redacting the token loses nothing.
    const state = await req('GET', `${base}/api/state`);
    const msgs = ((state.json && state.json.events) || []).map((x) => String(x.msg || ''));
    ok(!msgs.some((s) => s.includes(r.id)), 'refusal warn line: carries no capability token at all');
  }
  // An ACCEPTED cost must leave no refusal record - the count has to mean something.
  {
    const before = (await store.readEvents('costFloorRefused')).length;
    const r = await requests.createForLoad(mkLoad('DF-11b'));
    await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '22000' }) });
    ok((await store.readEvents('costFloorRefused')).length === before,
      'refusal: an accepted cost appends nothing (no false positives in the count)');
  }
  // A PMT load is carved out before any comparison, so it can never produce a refusal record either.
  {
    const before = (await store.readEvents('costFloorRefused')).length;
    const r = await requests.createForLoad(mkLoad('DF-11c', { quoteType: 'PMT', units: 22 }));
    await req('POST', `${base}/price/${r.id}`, { body: form({ cost: '800' }) });
    ok((await store.readEvents('costFloorRefused')).length === before,
      'refusal: a PMT capture below the rupee floor appends nothing (carve-out, not a refusal)');
  }

  console.log('\n12. the boot log names the floor in force (a typo is visible at restart, not a day later)');

  {
    const line = costFloorBootLine();
    ok(/desk cost floor/.test(line), 'boot line: labelled so it is findable in pm2-out.log');
    ok(/abs Rs 5000/.test(line) && /per-km Rs 10\/km/.test(line), 'boot line: prints BOTH effective knobs');
    ok(/TRUCK basis only/.test(line) && /PMT exempt/.test(line), 'boot line: states the basis carve-out');
  }

  console.log('\n13. the refusal surface is announced, persistent, and the preview stops promising prices');

  // Shipped-bytes pins, the same technique Part 9 uses: the page JS is assembled in a template literal
  // and nothing compiles it, so the behaviour has to be asserted against what actually goes over the
  // wire. (test-price-page-js.js owns the "does it parse" half of that gate.)
  {
    const r = await requests.createForLoad(mkLoad('DF-13', { distanceKm: 620 }));
    const page = await req('GET', `${base}/price/${r.id}`);
    ok(/setAttribute\('role',isErr\?'alert':'status'\)/.test(page.text),
      'page: the popup carries role=alert on an error (role=status otherwise) - it was announced to nobody');
    ok(/setAttribute\('aria-live',isErr\?'assertive':'polite'\)/.test(page.text),
      'page: aria-live is assertive for an error, matching the #closewarn idiom escalated');
    ok(/Check for a missing digit and re-enter\.',true,true\)/.test(page.text),
      'page: the hard-floor refusal is raised STICKY (it must survive while the desk retypes)');
    ok(/if\(!sticky\)toastTimer=setTimeout\(dismiss,3500\)/.test(page.text),
      'page: only a non-sticky popup auto-dismisses; the blocking refusal does not');
    ok(/if\(HARDFLOOR>0&&cv<HARDFLOOR\)\{pvSeq\+\+/.test(page.text),
      'page: previewLadder short-circuits below the hard floor instead of calling /preview');
    ok(/No prices can go out at this rate/.test(page.text),
      'page: below the floor the preview says no prices go out, not "Prices that will go out"');
  }

  server.close();

  // ------------------------------------------------------------------------------------------------
  // PART 14 - the knobs. Each case needs a FRESH process: config.js reads env at require time, so an
  // in-process mutation would lie against a warm require cache (same technique as
  // test-loadrules-config-edges.js). The child runs this file's own scenarios under a controlled env.
  // ------------------------------------------------------------------------------------------------
  console.log('\n14. knobs: 0 disables (legacy behaviour restored byte-for-byte), junk degrades to defaults');

  const CHILD = `
const os=require('os'),fs=require('fs'),path=require('path'),http=require('http');
process.env.PLATFORM='mock';process.env.STORE_BACKEND='memory';process.env.SP_HARD_CLOSE_ONLY='0';
process.env.SP_NOTIFY_MODE='dashboard';process.env.SP_MIN_PLAUSIBLE_COST='500';
process.env.SP_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'sp-desk-floor-child-'));
const {app,requests,costFloorBootLine}=require(${JSON.stringify(path.join(__dirname, '..', 'src', 'web', 'server.js'))});
const cfg=require(${JSON.stringify(path.join(__dirname, '..', 'src', 'config.js'))});
function post(base,token,body){return new Promise(function(res,rej){
  const b=Object.entries(body).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
  const u=new URL(base+'/price/'+token);
  const r=http.request({hostname:u.hostname,port:u.port,path:u.pathname,method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded','content-length':Buffer.byteLength(b)}},
    (rs)=>{let t='';rs.on('data',d=>t+=d);rs.on('end',()=>res({status:rs.statusCode,text:t}));});
  r.on('error',rej);r.write(b);r.end();});}
(async()=>{
  const server=app.listen(0);await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  const now=Date.now();
  const mk=(id,over)=>Object.assign({id:id,lane:{origin:'A',destination:'B'},equipment:'32ft',units:1,
    quoteType:'FTL',companyName:'Waaree',closesAt:now+20*60000,startsAt:now-60000,
    softClose:false,closeModelKnown:true,status:'live'},over||{});
  const out={abs:cfg.minCostAbs,perKm:cfg.minCostPerKm,bootLine:costFloorBootLine()};
  const r1=await requests.createForLoad(mk('K-1'));
  out.plain1500=(await post(base,r1.id,{cost:'1500'})).status;
  const r2=await requests.createForLoad(mk('K-2'));
  out.ack2=(await post(base,r2.id,{cost:'20',low_cost_ack:'1'})).status;
  const r3=await requests.createForLoad(mk('K-3'));
  out.plain2=(await post(base,r3.id,{cost:'2'})).status;
  const r4=await requests.createForLoad(mk('K-4',{distanceKm:620}));
  out.km5500=(await post(base,r4.id,{cost:'5500'})).status;
  server.close();
  // Sentinel-fenced: the app logs to stdout too, so the payload has to be extractable from the noise.
  process.stdout.write('<<RESULT>>'+JSON.stringify(out)+'<</RESULT>>');
})().catch(e=>{console.error(e);process.exit(1);});
`;
  function child(env) {
    const e = Object.assign({}, process.env, env);
    delete e.SP_DATA_DIR;
    const r = spawnSync(process.execPath, ['-e', CHILD], { env: e, encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0) throw new Error('child failed: ' + (r.stderr || '').slice(0, 800));
    const m = /<<RESULT>>([\s\S]*?)<<\/RESULT>>/.exec(String(r.stdout));
    if (!m) throw new Error('child emitted no result payload; stdout tail=' + String(r.stdout).slice(-400));
    return JSON.parse(m[1]);
  }

  // (a) BOTH knobs 0 -> the hard band is gone and the LEGACY soft behaviour is exactly what remains.
  {
    const c = child({ SP_MIN_COST_ABS: '0', SP_MIN_COST_PER_KM: '0' });
    ok(c.abs === 0 && c.perKm === 0, 'knobs 0: config carries 0/0 (an explicit zero is honoured, not defaulted)');
    ok(c.plain1500 === 200, 'knobs 0: Rs 1,500 is ACCEPTED again (hard band disabled - legacy behaviour)');
    ok(c.ack2 === 200, 'knobs 0: the legacy acked Rs 20 arms again (soft confirm-through restored)');
    ok(c.plain2 === 400, 'knobs 0: the legacy SOFT guard still rejects an unconfirmed Rs 2 (unchanged)');
    ok(c.km5500 === 200, 'knobs 0: the per-km floor is gone too (Rs 5,500 on a 620 km lane accepted)');
    ok(/DISABLED/.test(c.bootLine), 'knobs 0: the boot line says DISABLED, so a box with no floor announces it');
  }

  // (b) only the per-km knob 0 -> the absolute floor still stands.
  {
    const c = child({ SP_MIN_COST_ABS: '5000', SP_MIN_COST_PER_KM: '0' });
    ok(c.plain1500 === 400, 'per-km 0: the absolute Rs 5,000 floor still rejects Rs 1,500');
    ok(c.km5500 === 200, 'per-km 0: Rs 5,500 on a 620 km lane is accepted (only the km term was disabled)');
  }

  // (c) only the absolute knob 0 -> the per-km floor still stands where a distance exists.
  {
    const c = child({ SP_MIN_COST_ABS: '0', SP_MIN_COST_PER_KM: '10' });
    ok(c.km5500 === 400, 'abs 0: the per-km floor alone still rejects Rs 5,500 on a 620 km lane');
    ok(c.plain1500 === 200, 'abs 0: a distance-less load has no floor left (Rs 1,500 accepted)');
  }

  // (d) junk env degrades to the DEFAULTS - never to NaN, which would silently disable the guard: a
  //     NaN knob is coerced to 0 inside hardCostFloorFor, the effective floor collapses to 0, and the
  //     `!(floor > 0)` short-circuit then waves every cost through = fail open on live money. This is
  //     the money-safety direction.
  {
    const c = child({ SP_MIN_COST_ABS: 'abc', SP_MIN_COST_PER_KM: 'xyz' });
    ok(c.abs === 5000 && c.perKm === 10, 'junk env: degrades to the defaults 5000/10 (never NaN)');
    ok(c.plain1500 === 400, 'junk env: the guard still fires (fail SAFE, not open)');
  }

  // (e) env absent entirely -> the shipped defaults.
  {
    const c = child({ SP_MIN_COST_ABS: '', SP_MIN_COST_PER_KM: '' });
    ok(c.abs === 5000 && c.perKm === 10, 'env absent/blank: the shipped defaults 5000/10 apply');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
