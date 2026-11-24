'use strict';
/**
 * T6 - a 0% floor margin bids the load at cost.
 *
 * buildBandLadder derives the operating floor as max(cost, cost x (1 + minMarginPct/100)), so a
 * floor margin of 0 makes the floor EXACTLY the desk's cost. selectRung then spends down to that
 * floor as ordinary behaviour, and the load goes on the wire at the number the desk typed as its
 * own buying price. Measured on the box 2026-09-09: 133 loads carried minMarginPct 0 and all 133
 * had floor === cost; 77 bid at exactly cost, 13 of those won, moving Rs 5,59,500 of freight at no
 * margin. Both sources were a stored zero nobody remembered setting - a global default set
 * 2026-07-23 and reverted 2026-08-01, and a customer default live since 2026-07-25.
 *
 * The clamp warning at pricing.js:120 tested `marginFloor < trueCost`, so it fired on a NEGATIVE
 * margin and never at exactly 0 - the one instrument built to catch a mis-set floor was blind to
 * the value that costs the most.
 *
 * Five gates pinned here, outermost first:
 *   1. the /price page REFUSES the submit when the resolved margins would bid at cost;
 *   2. validateMargins rejects a 0 floor margin on save (global config, customer default, per-load
 *      override - one validator, all three write paths);
 *   3. buildBandLadder still floors at cost, but no longer silently;
 *   4. armFromRequest substitutes the house default for a stored zero rather than arming at cost;
 *   5. the /price page SURFACES the same refusal at the field, on GET, before any submit - the
 *      owner's complaint (2026-09-11) was that the desk only learned this after typing a cost and
 *      submitting, into a six-line "Could not save" page. Sections 10-13 pin the GET-rendered
 *      inline block + disabled submit and the CAPTURE-vs-RE-PRICE split in what it judges (a
 *      first capture reads the record's own resolved band, including an EXPLICIT stored zero
 *      invisible in every displayed row; a re-price always re-derives the floor from the rows on
 *      screen, because that is what parseBandForm(req.body) actually enforces on that path -
 *      judging the invisible field there would desync the hint from the real gate).
 *
 *   node scripts/test-zero-floor-guard.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';    // no WhatsApp send in a unit test
process.env.SP_MIN_COST_ABS = '0';           // the clerical-error floor is a different guard
process.env.SP_MIN_COST_PER_KM = '0';
process.env.SP_MIN_PLAUSIBLE_COST = '1';     // keep the low-cost guard out of the way
// THE LIVE SHAPE, as a boot default rather than a saved one: config.save() now refuses a 0 floor, so
// the only way a zero still reaches a resolved band is exactly how it reached the box - a stored
// value written before the guard existed. An env band reproduces that without faking a store write.
process.env.SP_MARGINS_PCT = '12.6,7.2,0';
process.env.SP_MIN_MARGIN_PCT = '0';
// A real admin hash, because the console's margin/clear route is session-gated and the auth-off dev
// path would never exercise it as an operator actually hits it.
const { hashPassword } = require('../src/auth/adminAuth');
process.env.SP_ADMIN_USER = 'admin';
process.env.SP_ADMIN_PASS_HASH = hashPassword('testpass');
process.env.SP_SESSION_SECRET = 'unit-test-secret-do-not-ship';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-zerofloor-'));

const assert = require('assert');
const http = require('http');
const { validateMargins, parseBandForm } = require('../src/pricing/marginValidate');
const { buildBandLadder } = require('../src/engine/pricing');
const { armFromRequest } = require('../src/pricing/priceRequests');
const appConfig = require('../src/config');
const { app, requests } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };
function throwsBad(fn, label) {
  try { fn(); } catch (e) {
    return ok(e.code === 'BAD_INPUT', `${label}${e.code === 'BAD_INPUT' ? '' : ` (threw ${e.code || 'no code'})`}`);
  }
  ok(false, `${label} - nothing thrown`);
}

function req(method, url, body, { contentType = null, cookie = null, origin = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType || 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(body); }
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => {
          let json = null; try { json = JSON.parse(buf); } catch (_) {}
          resolve({ status: res.statusCode, text: buf, json, setCookie: res.headers['set-cookie'] || [] });
        });
      });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const cookieFrom = (arr) => { for (const c of arr) { const m = /^sp_session=([^;]*)/.exec(c); if (m) return `sp_session=${m[1]}`; } return null; };

const now = Date.now();
const mkLoad = (id) => ({
  id, lane: { origin: 'Bhiwandi', destination: 'Bawal' }, equipment: '32 Feet', units: 1,
  companyName: 'Adama India Private Limited', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: null,
});

// The pricing logger writes JSON lines to console.error on warn. Capture them so "not silent" is an
// assertion about what an operator can actually read, not about a code path having been entered.
function captureWarnings(fn) {
  const lines = [];
  const real = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.error = real; }
  return lines;
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // =============================================================================================
  console.log('\n1. THE PAGE: a resolved band that would bid at cost refuses the submit');
  // =============================================================================================
  {
    const r = await requests.createForLoad(mkLoad('ZF-PAGE'), { deadlineAt: now + 30 * 60_000 });
    assert.strictEqual(r.minMarginPct, 0, 'fixture precondition: the request inherited the zero band');
    const res = await req('POST', `${base}/price/${r.id}`, form({ cost: '24000' }));
    ok(res.status === 400, `submit is refused (HTTP ${res.status}, expected 400)`);

    const after = await requests.getByToken(r.id);
    ok(after.status === 'awaiting_price', 'nothing was saved - the request stays open for a corrected margin');
    ok(!after.price, 'no cost was stored');

    // The desk cannot parse "band" / "floor" / "your lowest price" - established by the client on
    // the 2026-09-08 call. The message has to name the problem and the fix in words they use.
    // The refusal sentence itself, as rendered - not the surrounding page, whose CSS class names
    // legitimately contain words the copy may not.
    const msg = (res.text.match(/<div class="sb">([\s\S]*?)<\/div>/) || [])[1] || '';
    ok(/never-go-below price/.test(msg), 'the message uses the desk\'s own words for the lowest price');
    ok(/Rs 24,000/.test(msg), 'the message names the rupee figure the desk just entered');
    ok(/0%/.test(msg), 'the message names the setting that is wrong');
    ok(/corrected/.test(msg), 'the message names the fix');
    ok(!/\bband\b/i.test(msg) && !/\bfloor\b/i.test(msg) && !/your lowest price/i.test(msg),
      'the message avoids the three phrases the client provably cannot parse');
    ok(!/[—–]/.test(msg), 'no em or en dashes (the desk reads this on a phone)');
  }

  // =============================================================================================
  console.log('\n2. THE PAGE: a real band is unaffected');
  // =============================================================================================
  {
    const r = await requests.createForLoad(mkLoad('ZF-OK'), { deadlineAt: now + 30 * 60_000 });
    // The desk's own inline editor overrides the inherited zero with a real band - the load prices
    // normally and nothing about this guard is in the way.
    const res = await req('POST', `${base}/price/${r.id}`,
      form({ cost: '24000', use_override: '1', m_0: '12.6', m_1: '7.2', m_2: '5' }));
    ok(res.status === 200, `a band with a real lowest margin submits normally (HTTP ${res.status})`);
    const after = await requests.getByToken(r.id);
    ok(after.status === 'armed' && after.price && after.price.cost === 24000, 'the cost was captured and the load armed');
    ok(after.minMarginPct === 5, 'the override band was stored as entered');
  }

  // =============================================================================================
  console.log('\n3. THE PAGE: a 0% lowest bid typed into the editor is refused too');
  // =============================================================================================
  {
    const r = await requests.createForLoad(mkLoad('ZF-TYPED'), { deadlineAt: now + 30 * 60_000 });
    const res = await req('POST', `${base}/price/${r.id}`,
      form({ cost: '24000', use_override: '1', m_0: '12.6', m_1: '7.2', m_2: '0' }));
    ok(res.status === 400, `a typed 0% lowest bid is refused (HTTP ${res.status})`);
    const after = await requests.getByToken(r.id);
    ok(after.status === 'awaiting_price', 'nothing was saved');
  }

  // =============================================================================================
  console.log('\n4. THE VALIDATOR: one rejection, all three write paths');
  // =============================================================================================
  throwsBad(() => validateMargins([12.6, 7.2, 0], 0), 'validateMargins([12.6,7.2,0], 0) rejected');
  throwsBad(() => validateMargins([12.6, 7.2, 5], 0), 'a 0 floor is rejected even when every rung is above it');
  throwsBad(() => parseBandForm({ use_override: '1', m_0: '12.6', m_1: '7.2', m_2: '0' }),
    'parseBandForm rejects a 0% lowest bid (the /price editor derives the floor from it)');

  assert.deepStrictEqual(validateMargins([12.6, 7.2, 5], 5), { marginsPct: [12.6, 7.2, 5], minMarginPct: 5 });
  ok(true, 'validateMargins([12.6,7.2,5], 5) unchanged');
  assert.deepStrictEqual(parseBandForm({ use_override: '1', m_0: '13', m_1: '9', m_2: '7' }),
    { marginsPct: [13, 9, 7], minMarginPct: 7 });
  ok(true, 'parseBandForm on a real band unchanged');
  throwsBad(() => validateMargins([13, 9, 7], null), 'a cleared floor field is still rejected as blank, not as a zero');

  // =============================================================================================
  console.log('\n5. THE LADDER: still floors at cost, but never silently');
  // =============================================================================================
  {
    let plan;
    const warnings = captureWarnings(() => {
      plan = buildBandLadder({ cost: 24000, marginsPct: [12.6, 7.2, 0], minMarginPct: 0 });
    });
    ok(plan.floor === 24000, 'the floor is still clamped to cost, never below it');
    ok(warnings.some((l) => /"level":"warn"/.test(l) && /24000/.test(l)),
      'the at-cost case now emits a warning (it was silent: the guard tested `<`, not `<=`)');
  }
  {
    // The regression the widened comparison must not cause: an ordinary band stays quiet.
    const warnings = captureWarnings(() => buildBandLadder({ cost: 24000, marginsPct: [12.6, 7.2, 5], minMarginPct: 5 }));
    ok(warnings.length === 0, 'a real band emits no warning');
  }
  {
    // Golden ladders for non-zero bands, byte-identical.
    assert.deepStrictEqual(buildBandLadder({ cost: 50000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 }),
      { opening: 56300, floor: 53150, guard: 53150, trueCost: 50000, minMarginPct: 6.3, ladder: [56300, 53600, 53150], marginsPct: [12.6, 7.2, 6.3] });
    assert.deepStrictEqual(buildBandLadder({ cost: 24000, marginsPct: [12.6, 7.2, 5], minMarginPct: 5 }),
      { opening: 27024, floor: 25200, guard: 25200, trueCost: 24000, minMarginPct: 5, ladder: [27024, 25728, 25200], marginsPct: [12.6, 7.2, 5] });
    ok(true, 'golden ladders for non-zero bands are byte-identical');
    // A NEGATIVE stored margin still clamps and still warns - the case the old `<` did catch.
    const warnings = captureWarnings(() => buildBandLadder({ cost: 24000, marginsPct: [12.6, 7.2, -5], minMarginPct: -5 }));
    ok(warnings.some((l) => /"level":"warn"/.test(l)), 'a negative floor margin still warns (no regression on the old case)');
  }

  // =============================================================================================
  console.log('\n6. THE ARM SEAM: a stored zero fails closed to the house default, loudly');
  // =============================================================================================
  {
    // The rows already on the box: captured through the customer default before any of this
    // existed, and replayed onto the engine by a restart rehydrate or a scheduled wake without the
    // page ever rendering again. Arming at cost is not an option, so substitute and shout.
    // This file boots the app with SP_MIN_MARGIN_PCT=0 so the PAGE sees a resolved zero band, which
    // also makes the house default 0. Restore a real house default for the substitution tests; the
    // both-zero case is asserted separately below.
    appConfig.minMarginPct = 6.3;
    const alerts = [];
    let armedInputs = null;
    const engine = {
      caps: {},
      emit: (e) => alerts.push(e),
      arm: (_meta, inputs) => { armedInputs = inputs; return null; },
      schedule: (_meta, inputs) => { armedInputs = inputs; return null; },
    };
    const stored = {
      loadId: 'ZF-STORED', platformKey: 'sp', load: mkLoad('ZF-STORED'),
      price: { cost: 24000, marginsPct: [12.6, 7.2, 0], minMarginPct: 0 },
    };
    armFromRequest(engine, stored);
    ok(armedInputs != null, 'the load still arms - a stored zero must never forfeit the auction');
    ok(armedInputs.minMarginPct > 0, `the engine was armed with a real floor margin (${armedInputs && armedInputs.minMarginPct})`);
    const plan = buildBandLadder({ cost: 24000, marginsPct: armedInputs.marginsPct, minMarginPct: armedInputs.minMarginPct });
    ok(plan.floor > 24000, `the armed ladder no longer bottoms out at cost (floor ${plan.floor})`);
    const alert = alerts.find((a) => a.type === 'alert' && a.kind === 'zero_floor_margin_substituted');
    ok(!!alert, 'an operator alert is raised naming the substitution');
    ok(alert && alert.level === 'error', 'it is raised at error level, not buried as info');
    ok(alert && alert.auctionId === 'ZF-STORED', 'the alert names the load');
  }
  {
    // A real stored band is passed through untouched.
    let armedInputs = null;
    const engine = { caps: {}, emit: () => {}, arm: (_m, i) => { armedInputs = i; return null; }, schedule: (_m, i) => { armedInputs = i; return null; } };
    armFromRequest(engine, {
      loadId: 'ZF-STORED-OK', platformKey: 'sp', load: mkLoad('ZF-STORED-OK'),
      price: { cost: 24000, marginsPct: [12.6, 7.2, 5], minMarginPct: 5 },
    });
    assert.deepStrictEqual(armedInputs, { cost: 24000, marginsPct: [12.6, 7.2, 5], minMarginPct: 5 });
    ok(true, 'a real stored band reaches the engine unchanged');
  }
  {
    // Nothing left to fall back to: refuse rather than arm at cost. Unreachable in production now
    // that config.save() rejects a 0 global floor, but this is the branch that decides the posture.
    appConfig.minMarginPct = 0;
    let armed = false, err = null;
    const engine = { caps: {}, emit: () => {}, arm: () => { armed = true; return null; }, schedule: () => { armed = true; return null; } };
    try {
      armFromRequest(engine, {
        loadId: 'ZF-BOTH-ZERO', platformKey: 'sp', load: mkLoad('ZF-BOTH-ZERO'),
        price: { cost: 24000, marginsPct: [12.6, 7.2, 0], minMarginPct: 0 },
      });
    } catch (e) { err = e; }
    ok(!armed, 'a zero with a zero house default arms nothing');
    ok(err && err.code === 'BAD_INPUT', 'it refuses with BAD_INPUT rather than bidding at cost');
    appConfig.minMarginPct = 6.3;
  }

  // =============================================================================================
  console.log('\n7. THE ARM SEAM: the substitution is PERSISTED, not just applied in memory');
  // =============================================================================================
  {
    // Substituting only into the local `inputs` leaves the stored 0 in place, and every surface
    // that reads the request rather than the armed ladder then reports a margin the engine did not
    // use: notifier.js takes floorPct straight off price.minMarginPct while floorBid comes from the
    // ladder, so one receipt says "never below 0%" beside a floor of cost x 1.063. exportModel reads
    // the TOP-LEVEL minMarginPct, so both fields have to move or only half the surfaces are fixed.
    const created = await requests.createForLoad(mkLoad('ZF-PERSIST'), { deadlineAt: now + 30 * 60_000 });
    // Written straight through the store seam: this is a row captured before the /price gate
    // existed, which is the only way a stored zero still occurs.
    const seeded = await requests.store.patchDoc('priceRequests', created.id, {
      status: 'armed', minMarginPct: 0, marginsPct: [12.6, 7.2, 0],
      price: { cost: 24000, marginsPct: [12.6, 7.2, 0], minMarginPct: 0 },
    });
    assert.strictEqual(seeded.price.minMarginPct, 0, 'fixture precondition: the stored row carries a zero');

    const engine = { caps: {}, emit: () => {}, arm: () => null, schedule: () => null };
    armFromRequest(engine, seeded, { requests });

    // In memory FIRST - the receipt is sent synchronously off this same object, so it cannot wait
    // on an async write.
    ok(seeded.price.minMarginPct === 6.3, `the in-memory price band is corrected (${seeded.price.minMarginPct})`);
    ok(seeded.minMarginPct === 6.3, `the in-memory top-level band is corrected (${seeded.minMarginPct})`);

    // The exact expression notifier.js:554 evaluates, against the ladder the engine armed on.
    const ladder = buildBandLadder({ cost: 24000, marginsPct: seeded.price.marginsPct, minMarginPct: seeded.price.minMarginPct }).ladder;
    const floorPct = seeded.price.minMarginPct;
    const floorBid = ladder[ladder.length - 1];
    ok(floorPct !== 0, 'a receipt built off this record can no longer print floorPct 0');
    ok(floorBid === Math.round(24000 * 1.063), `floorBid ${floorBid} and floorPct ${floorPct} now describe the same ladder`);

    // Then durably, so a restart does not resurrect the zero.
    await new Promise((r) => setTimeout(r, 50));  // the heal write is fire-and-forget by design
    const reread = await requests.getByToken(created.id);
    ok(reread.price.minMarginPct === 6.3, `the STORED price band is corrected (${reread.price.minMarginPct})`);
    ok(reread.minMarginPct === 6.3, `the STORED top-level band is corrected (${reread.minMarginPct})`);
    ok(reread.price.cost === 24000, 'the cost is untouched');
    assert.deepStrictEqual(reread.price.marginsPct, [12.6, 7.2, 0], 'the margin steps are untouched');
    ok(true, 'the heal writes only the floor margin');
  }
  {
    // A real band is never written back - the heal must not touch a record it did not correct.
    const created = await requests.createForLoad(mkLoad('ZF-NOHEAL'), { deadlineAt: now + 30 * 60_000 });
    const seeded = await requests.store.patchDoc('priceRequests', created.id, {
      status: 'armed', minMarginPct: 5, marginsPct: [12.6, 7.2, 5],
      price: { cost: 24000, marginsPct: [12.6, 7.2, 5], minMarginPct: 5 },
    });
    const before = JSON.stringify(seeded);
    armFromRequest({ caps: {}, emit: () => {}, arm: () => null, schedule: () => null }, seeded, { requests });
    await new Promise((r) => setTimeout(r, 50));
    ok(JSON.stringify(seeded) === before, 'a record with a real margin is left byte-identical');
  }
  {
    // The heal reads the record and then patches it, and patchDoc replaces `price` wholesale (a
    // shallow top-level Object.assign), so writing back a price object built from a stale read
    // would silently revert a re-price that landed in between - losing the desk's new COST, not
    // just a margin. Pin the guard that makes the heal a no-op once anything else has moved the
    // floor off zero.
    const created = await requests.createForLoad(mkLoad('ZF-RACE'), { deadlineAt: now + 30 * 60_000 });
    await requests.store.patchDoc('priceRequests', created.id, {
      status: 'armed', minMarginPct: 0, marginsPct: [12.6, 7.2, 0],
      price: { cost: 24000, marginsPct: [12.6, 7.2, 0], minMarginPct: 0 },
    });
    // The interleaving write: a re-price lands with a new cost AND a real margin.
    await requests.store.patchDoc('priceRequests', created.id, {
      minMarginPct: 8, marginsPct: [15, 11, 8],
      price: { cost: 31000, marginsPct: [15, 11, 8], minMarginPct: 8 },
    });
    // The heal from the earlier arm now fires against the already-corrected record.
    const healed = await requests.healZeroFloorMargin(created.id, 6.3);
    ok(healed === null, 'the heal declines a record whose floor is no longer zero');
    const reread = await requests.getByToken(created.id);
    ok(reread.price.cost === 31000, `the re-priced cost survives (${reread.price.cost}, not reverted to 24000)`);
    ok(reread.price.minMarginPct === 8, `the re-priced margin survives (${reread.price.minMarginPct})`);
    assert.deepStrictEqual(reread.price.marginsPct, [15, 11, 8], 'the re-priced steps survive');
  }

  // =============================================================================================
  console.log('\n8. THE CONSOLE: margin/clear refuses to restore a zero onto a live armed load');
  // =============================================================================================
  {
    const login = await req('POST', `${base}/api/login`,
      JSON.stringify({ user: 'admin', password: 'testpass' }), { contentType: 'application/json', origin: base });
    const cookie = cookieFrom(login.setCookie);
    ok(!!cookie, 'admin login issues a session cookie');

    // The live shape: the desk overrode this customer's zero to get the load biddable, the load is
    // armed and bidding on that override, and someone now hits "revert to standard margins" - where
    // "standard" for this customer IS the zero.
    const r = await requests.createForLoad(mkLoad('ZF-CLEAR'), { deadlineAt: now + 30 * 60_000 });
    const armedRes = await req('POST', `${base}/price/${r.id}`,
      form({ cost: '24000', use_override: '1', m_0: '12.6', m_1: '7.2', m_2: '5' }));
    ok(armedRes.status === 200, 'the load arms on the desk override');
    const armedDoc = await requests.getByToken(r.id);
    ok(armedDoc.status === 'armed' && armedDoc.minMarginPct === 5, 'it is armed on the 5% override');

    const clear = await req('POST', `${base}/api/price-requests/${r.id}/margin/clear`,
      JSON.stringify({ confirm: true }), { contentType: 'application/json', cookie, origin: base });
    ok(clear.status === 400, `the revert is refused (HTTP ${clear.status}, expected 400)`);

    const msg = (clear.json && clear.json.error) || '';
    ok(/0%/.test(msg), 'the message names the setting that is wrong');
    ok(/Rs 24,000/.test(msg), 'the message names the rupee figure it would bid at');
    ok(/never-go-below price/.test(msg), 'it uses the same words as the desk page');
    ok(/still bidding/.test(msg), 'it says the live load was NOT disturbed');
    ok(!/\bband\b/i.test(msg) && !/\bfloor\b/i.test(msg) && !/your lowest price/i.test(msg),
      'it avoids the three phrases the client cannot parse');
    ok(!/[—–]/.test(msg), 'no em or en dashes');

    // The load must be untouched: refusing has to leave the working bidding position alone.
    const after = await requests.getByToken(r.id);
    ok(after.status === 'armed', 'the load is still armed');
    ok(after.minMarginPct === 5, `it is still on the 5% override (${after.minMarginPct})`);
    ok(after.marginOverride != null, 'the override was not cleared');
  }
  {
    // The mirror: a customer with a real inherited margin still reverts normally.
    const login = await req('POST', `${base}/api/login`,
      JSON.stringify({ user: 'admin', password: 'testpass' }), { contentType: 'application/json', origin: base });
    const cookie = cookieFrom(login.setCookie);
    await requests.customersProvider.upsert({ customerId: 'realmargin', label: 'RealMargin',
      aliases: ['RealMargin Ltd'], margin: { marginsPct: [12.6, 7.2, 6], minMarginPct: 6 } });
    const load = { ...mkLoad('ZF-CLEAR-OK'), companyName: 'RealMargin Ltd' };
    const r = await requests.createForLoad(load, { deadlineAt: now + 30 * 60_000 });
    ok(r.minMarginPct === 6, `fixture: inherited a real 6% margin (${r.minMarginPct})`);
    await req('POST', `${base}/price/${r.id}`,
      form({ cost: '24000', use_override: '1', m_0: '13', m_1: '9', m_2: '8' }));
    const clear = await req('POST', `${base}/api/price-requests/${r.id}/margin/clear`,
      JSON.stringify({ confirm: true }), { contentType: 'application/json', cookie, origin: base });
    ok(clear.status === 200, `a real inherited margin reverts normally (HTTP ${clear.status})`);
    const after = await requests.getByToken(r.id);
    ok(after.minMarginPct === 6, `it reverted to the inherited 6% (${after.minMarginPct})`);
  }

  // =============================================================================================
  console.log('\n9. THE PAGE: the desk revert gets revert-shaped copy, not capture-shaped copy');
  // =============================================================================================
  {
    // Same hazard from the desk's own "Revert to standard margins" button. The copy must not say
    // "the cost you entered" - on a revert the desk entered no cost, and the load keeps bidding.
    const r = await requests.createForLoad(mkLoad('ZF-REVERT'), { deadlineAt: now + 30 * 60_000 });
    await req('POST', `${base}/price/${r.id}`,
      form({ cost: '24000', use_override: '1', m_0: '12.6', m_1: '7.2', m_2: '5' }));
    const res = await req('POST', `${base}/price/${r.id}`, form({ revert_override: '1' }));
    ok(res.status === 400, `the desk revert is refused (HTTP ${res.status})`);
    const msg = (res.text.match(/<div class="sb">([\s\S]*?)<\/div>/) || [])[1] || '';
    ok(/still bidding/.test(msg), 'it tells the desk the load is still bidding on its current margins');
    ok(!/cost you entered/.test(msg), 'it does not claim the desk entered a cost on this submit');
    ok(!/[—–]/.test(msg), 'no em or en dashes');
    const after = await requests.getByToken(r.id);
    ok(after.minMarginPct === 5, `the working position is untouched (${after.minMarginPct})`);
  }

  // =============================================================================================
  console.log('\n10. THE PAGE (GET): a zero-margin band shows the inline block and disables submit');
  // =============================================================================================
  {
    // No cost typed yet, no submit made - the whole point is that this is knowable at render.
    const r = await requests.createForLoad(mkLoad('ZF-INLINE'), { deadlineAt: now + 30 * 60_000 });
    const res = await req('GET', `${base}/price/${r.id}`);
    ok(res.status === 200, `the page renders (HTTP ${res.status})`);
    const note = (res.text.match(/<div class="snote[^"]*" id="zmNote"[^>]*>[\s\S]*?<\/div>\s*<\/div>/) || [])[0] || '';
    ok(!!note, 'the inline block is present in the markup');
    ok(/class="snote bad"/.test(note), 'it renders in the error (bad) state, not merely present-but-neutral');
    ok(!/\bhidden\b/.test(note), 'it is NOT hidden - visible before any cost is typed');
    ok(/id="zmNote"[\s\S]*?<div class="st" id="zmHead">This customer&#39;s margin setting is 0%<\/div>/.test(note)
      || /This customer.s margin setting is 0%/.test(note), 'line 1 names what is wrong');
    ok(/Every bid on this load would go out at cost - the margin setting has to be corrected before this load can be priced/.test(note),
      'line 2 says who fixes it, in at most two short lines');
    ok(!/\bband\b/i.test(note) && !/\bfloor\b/i.test(note) && !/your lowest price/i.test(note),
      'the inline copy avoids the three phrases the client cannot parse');
    ok(!/Rs\s?[\d,]/.test(note) && !/\b\d+(\.\d+)?%/.test(note.replace('0%', '')), 'no rupee figure and no percentage other than the margin % itself');
    const btnTag = (res.text.match(/<button type="submit"[^>]*>/) || [])[0] || '';
    ok(/\bdisabled\b/.test(btnTag), 'the submit button is disabled server-side, before any JS runs');
    const costTag = (res.text.match(/<input id="cost"[^>]*>/) || [])[0] || '';
    ok(costTag.includes('value=""'), 'the cost field is untouched/empty - nothing was lost, nothing was ever there to lose');
  }

  // =============================================================================================
  console.log('\n11. THE PAGE (GET): a real band shows no inline block and an enabled submit');
  // =============================================================================================
  {
    const r = await requests.createForLoad(mkLoad('ZF-INLINE-OK'), { deadlineAt: now + 30 * 60_000 });
    assert.strictEqual(r.minMarginPct, 0, 'fixture precondition: creation still inherits the env-default zero band');
    // A real band, written directly the same way test 7's fixtures simulate a corrected record -
    // this section is about what the PAGE does with a real band, not how one gets stored.
    await requests.store.patchDoc('priceRequests', r.id, { minMarginPct: 5, marginsPct: [12.6, 7.2, 5] });
    const res = await req('GET', `${base}/price/${r.id}`);
    ok(/id="zmNote" hidden/.test(res.text), 'the inline block is present but hidden');
    ok(!/class="snote bad" id="zmNote"/.test(res.text), 'it does not render in the bad state');
    const btnTag = (res.text.match(/<button type="submit"[^>]*>/) || [])[0] || '';
    ok(!/\bdisabled\b/.test(btnTag), 'the submit button is enabled');
  }

  // =============================================================================================
  console.log('\n12. THE PAGE (GET, CAPTURE): an invisible explicit zero IS caught pre-submit');
  // =============================================================================================
  {
    // A legacy shape: the record's own resolved band carries an EXPLICIT minMarginPct of 0 that
    // does not appear as any of the displayed rows (all three are real numbers). Nothing on the
    // rendered page shows a 0 anywhere - this is exactly why effectiveFloorMarginPct reads the
    // explicit field first rather than trusting what the rows show.
    const created = await requests.createForLoad(mkLoad('ZF-INVISIBLE'), { deadlineAt: now + 30 * 60_000 });
    await requests.store.patchDoc('priceRequests', created.id, { minMarginPct: 0, marginsPct: [12.6, 7.2, 5] });
    const res = await req('GET', `${base}/price/${created.id}`);
    ok(/class="snote bad" id="zmNote"/.test(res.text), 'the capture page catches the invisible zero even though every displayed row is a real number');
    const btnTag = (res.text.match(/<button type="submit"[^>]*>/) || [])[0] || '';
    ok(/\bdisabled\b/.test(btnTag), 'submit stays disabled for the invisible case too');
  }

  // =============================================================================================
  console.log('\n13. THE PAGE (GET, RE-PRICE): an armed load judges the rows on screen, not the field');
  // =============================================================================================
  {
    // Mirror fixture, but ARMED. A re-price submit always re-derives the floor from parseBandForm
    // on the posted rows (see server.js ~line 2648) - the explicit stored field is never read on
    // that path, so a hint that judged it here would tell the desk a re-price is blocked when the
    // actual submit would go through clean. This is the split the implementation comment documents.
    const created = await requests.createForLoad(mkLoad('ZF-REPRICE-INVISIBLE'), { deadlineAt: now + 30 * 60_000 });
    await requests.store.patchDoc('priceRequests', created.id, {
      status: 'armed', minMarginPct: 0, marginsPct: [12.6, 7.2, 5],
      price: { cost: 24000, marginsPct: [12.6, 7.2, 5], minMarginPct: 0 },
    });
    const res = await req('GET', `${base}/price/${created.id}`);
    ok(/id="zmNote" hidden/.test(res.text), 're-price reads the displayed rows (all real), not the invisible stored field - no false block');
    const btnTag = (res.text.match(/<button type="submit"[^>]*>/) || [])[0] || '';
    ok(!/\bdisabled\b/.test(btnTag), 're-price submit stays enabled - it would in fact succeed');

    // And the mirror-image: an armed load whose DISPLAYED rows themselves carry a visible 0 is
    // still caught, because re-price reads exactly those rows.
    const created2 = await requests.createForLoad(mkLoad('ZF-REPRICE-VISIBLE'), { deadlineAt: now + 30 * 60_000 });
    await requests.store.patchDoc('priceRequests', created2.id, {
      status: 'armed', minMarginPct: 5, marginsPct: [12.6, 7.2, 0],
      price: { cost: 24000, marginsPct: [12.6, 7.2, 0], minMarginPct: 5 },
    });
    const res2 = await req('GET', `${base}/price/${created2.id}`);
    ok(/class="snote bad" id="zmNote"/.test(res2.text), 're-price catches a 0 that is visible on the rows even when the stored field says otherwise');
  }

  // =============================================================================================
  console.log('\n14. THE PAGE (GET): a disabled submit is visually muted, not just attribute-disabled');
  // =============================================================================================
  {
    // The server has set the `disabled` HTML attribute on this button since Test 10 shipped, but
    // the CSS never gave `:disabled` its own look, so the button still rendered live-green - the
    // desk had no way to tell a code-disabled button from a working one without opening devtools.
    // This pins the CLASS/ATTR PAIRING itself: the disabled button and a CSS rule that visibly
    // mutes it must both be present on the same page, so one cannot regress without the other.
    const r = await requests.createForLoad(mkLoad('ZF-VISUAL'), { deadlineAt: now + 30 * 60_000 });
    const res = await req('GET', `${base}/price/${r.id}`);
    const btnTag = (res.text.match(/<button type="submit"[^>]*>/) || [])[0] || '';
    ok(/\bdisabled\b/.test(btnTag), 'precondition: this fixture renders a disabled submit button');

    const style = (res.text.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
    ok(!!style, 'the page ships an embedded stylesheet');
    const baseRule = (style.match(/\bbutton\{[^}]*\}/) || [])[0] || '';
    // Anchored to the STANDALONE selector. The held-state work adds a compound rule
    // (`.heldpage #mainForm>button:disabled`) that sorts earlier in the sheet, and an unanchored
    // match picks that one up instead of the general rule this section is about.
    const disabledRule = (style.match(/(?:^|[}\s;])button:disabled\{([^}]*)\}/) || [])[1] || '';
    ok(!!baseRule, 'precondition: the base button rule is present (green/primary submit)');
    ok(!!disabledRule, 'a button:disabled rule exists - the same seam an attribute-only fix would miss');
    ok(/background:\s*var\(--muted\)/.test(disabledRule), 'disabled state uses the page\'s own muted background token, not the primary green');
    ok(/color:\s*var\(--muted-fg\)/.test(disabledRule), 'disabled state uses the page\'s own muted foreground token, not white');
    ok(/cursor:\s*not-allowed/.test(disabledRule), 'disabled state carries a not-allowed cursor');
    ok(!disabledRule.includes('var(--primary)') && !/color:\s*#fff/.test(disabledRule),
      'the disabled rule does not just repeat the live-button colors - it must actually differ from "background:var(--primary)...color:#fff" or a code-disabled button still LOOKS enabled');
  }

  server.close();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
