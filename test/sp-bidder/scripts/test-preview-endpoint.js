'use strict';
/**
 * CONTRACT test for the live ladder-preview seam: GET /price/:token/preview?cost=N&m=a,b,c
 *
 * This pins the SHAPE and RULES of the seam the desk price page polls while an operator edits
 * cost/margins - NOT the pricing math (that is priced elsewhere). The invariant that matters:
 * the preview endpoint wraps engine.planPreview() (side-effect-free _planFor), and it MUST stay
 * in exact parity with what arming actually produces. Drift here means the desk approves a price
 * that is not what the engine fires.
 *
 * Directions pinned:
 *   response - { ladder:number[], floor, rungCount } shape, strictly-descending ladder,
 *              floor === last rung, rungCount === length, Cache-Control: no-store, content-type
 *   request  - cost gate (missing/0/negative/NaN/Infinity/non-numeric -> 400), ?m= validated with
 *              the SAME validateMargins the save path uses (junk rejected, never silently filtered;
 *              >12 rejected), unknown token -> 404, error envelope { error:string }
 *   parity   - preview ladder deep-equals the ARMED monitor's ladder from engine.snapshot()
 *   no-write - preview creates/alters no monitor and no price-request record
 *
 * Clock: PER-COMMIT. This is an in-process FE<->BE seam over the memory store; it hits no external
 * provider, so it runs on every commit (not the nightly provider-endpoint job).
 *
 * House pattern copied from scripts/test-price-states.js: boot the app in mock mode over the memory
 * store on a fixed loopback port, seed price requests through the real requests API, hit it over HTTP.
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
// exercise the seam with the login gate OFF (mock dev default); clear ambient admin creds.
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), never app state
const path = require('path');
// the mock stack's DurableScheduler writes intents.json on arm - keep it out of the repo's data/,
// in an isolated temp dir fresh per run so parallel runs never collide.
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-preview-contract-'));

const http = require('http');
const { app, requests, engine } = require('../src/web/server');

// Fixed loopback port in the orchestrator-assigned 4570-4579 range - no other test uses it (the
// rest bind :0), so parallel test-file runs never contend for it.
const PORT = 4573;

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`PASS - ${name}`); }
  else { fail++; console.error(`FAIL - ${name}`); }
};

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
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => {
          let json = null; try { json = JSON.parse(buf); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, text: buf, json });
        });
      },
    );
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

// ---- contract helpers (shape, not values) ----
const isNumberArray = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'number' && Number.isFinite(x));
const isStrictlyDescending = (a) => Array.isArray(a) && a.every((v, i) => i === 0 || v < a[i - 1]);
const jsonCT = (r) => String((r.headers || {})['content-type'] || '').includes('application/json');
const isErrorEnvelope = (r) => r.json && typeof r.json.error === 'string' && r.json.error.length > 0;

(async () => {
  const server = app.listen(PORT, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${PORT}`;
  const get = (p) => req('GET', base + p);
  const postForm = (p, kv) => req('POST', base + p, { body: new URLSearchParams(kv).toString(), contentType: 'application/x-www-form-urlencoded' });
  const postJson = (p, obj) => req('POST', base + p, { body: JSON.stringify(obj) });

  const now = Date.now();
  const mkLoad = (id) => ({
    id, lane: { origin: 'Khopoli', destination: 'Keeranur' }, equipment: 'Trailer', units: 1,
    companyName: 'Syngenta India', closesAt: now + 10 * 60_000, startsAt: now - 60_000,
    softClose: false, status: 'live',
  });
  // hold the pricing window open explicitly (deadlineAt gates capture() alone, never engine timing),
  // exactly as test-price-states.js does, so a fast-derived deadline can't retire the fixture.
  const seed = (id) => requests.createForLoad(mkLoad(id), { deadlineAt: Date.now() + 60_000 });

  // ============================================================================================
  // 1) unknown_token_404 - the token IS the auth; an unknown one is a 404 error envelope, not a page.
  //    Mutation caught: 404->200/500 status regression, or dropping the { error } envelope.
  // ============================================================================================
  {
    // Act
    const r = await get('/price/NOTATOKEN/preview?cost=18000');
    // Assert (contract)
    ok(r.status === 404, 'unknown_token_404: unknown token -> 404');
    ok(isErrorEnvelope(r), 'unknown_token_404: body is an { error:string } envelope');
    ok(jsonCT(r), 'unknown_token_404: content-type is application/json');
  }

  // Seed one open request for the cost/margin gate cases.
  const rGate = await seed('PREV-GATE');

  // ============================================================================================
  // 2-6) cost gate - the endpoint's own rule is Number.isFinite(cost) && cost > 0. Each bad cost
  //      is a 400 { error }.  Mutation caught: relaxing the gate (e.g. dropping !Number.isFinite,
  //      or `>= 0` instead of `> 0`) would 200 one of these.
  // ============================================================================================
  {
    const cases = [
      ['cost_missing',  `/price/${rGate.id}/preview?m=6`],            // no cost -> Number(undefined)=NaN
      ['cost_zero',     `/price/${rGate.id}/preview?cost=0`],
      ['cost_negative', `/price/${rGate.id}/preview?cost=-5`],
      ['cost_nan',      `/price/${rGate.id}/preview?cost=abc`],       // non-numeric
      ['cost_infinity', `/price/${rGate.id}/preview?cost=Infinity`],  // Number('Infinity')===Infinity, must be rejected by isFinite
    ];
    for (const [name, url] of cases) {
      // Act
      const r = await get(url);
      // Assert
      ok(r.status === 400, `${name}: rejected with 400`);
      ok(isErrorEnvelope(r), `${name}: 400 body is an { error:string } envelope`);
      ok(r.json && r.json.ladder === undefined, `${name}: no ladder returned (not a silent success)`);
    }
  }

  // ============================================================================================
  // 7) happy_shape - valid cost -> 200 with the exact response contract, ladder strictly
  //    descending, floor === last rung, rungCount === length, Cache-Control: no-store present.
  //    Mutation caught: renaming any of { ladder, floor, rungCount }, changing a type, breaking the
  //    descending/floor/count invariants, or dropping the no-store header.
  // ============================================================================================
  {
    // Act
    const r = await get(`/price/${rGate.id}/preview?cost=18000`);
    // Assert (contract)
    ok(r.status === 200, 'happy_shape: valid cost -> 200');
    ok(jsonCT(r), 'happy_shape: content-type is application/json');
    ok(String((r.headers || {})['cache-control'] || '').includes('no-store'), 'happy_shape: Cache-Control: no-store present');
    const j = r.json || {};
    ok(isNumberArray(j.ladder), 'happy_shape: ladder is a non-empty number[]');
    ok(typeof j.floor === 'number' && Number.isFinite(j.floor), 'happy_shape: floor is a finite number');
    ok(typeof j.rungCount === 'number' && Number.isInteger(j.rungCount), 'happy_shape: rungCount is an integer');
    ok(isStrictlyDescending(j.ladder), 'happy_shape: ladder is strictly descending');
    ok(Array.isArray(j.ladder) && j.floor === j.ladder[j.ladder.length - 1], 'happy_shape: floor === last ladder rung');
    ok(Array.isArray(j.ladder) && j.rungCount === j.ladder.length, 'happy_shape: rungCount === ladder length');
  }

  // ============================================================================================
  // 8) margins_junk_rejected - ?m=abc,,9 must be a 400, NOT a 200 with the junk silently filtered
  //    down to [9]. This is the explicit "never silently filter" rule.
  //    Mutation caught: replacing validateMargins with a `.filter(Number.isFinite)` silent drop.
  // ============================================================================================
  {
    // Act
    const r = await get(`/price/${rGate.id}/preview?cost=18000&m=abc,,9`);
    // Assert
    ok(r.status === 400, 'margins_junk_rejected: junk margins -> 400');
    ok(isErrorEnvelope(r), 'margins_junk_rejected: 400 body is an { error:string } envelope');
    ok(r.json && r.json.ladder === undefined, 'margins_junk_rejected: did NOT return a 200 ladder built from filtered margins');
  }

  // ============================================================================================
  // 9) margins_too_many - >12 entries rejected.  Mutation caught: raising/removing the 12 cap.
  // ============================================================================================
  {
    const thirteen = Array.from({ length: 13 }, (_, i) => i + 1).join(','); // "1,2,...,13"
    // Act
    const r = await get(`/price/${rGate.id}/preview?cost=18000&m=${thirteen}`);
    // Assert
    ok(r.status === 400, 'margins_too_many: 13 entries -> 400');
    ok(isErrorEnvelope(r), 'margins_too_many: 400 body is an { error:string } envelope');
  }

  // ============================================================================================
  // 10) margins_save_parity - the SAME invalid margin sent to the SAVE path (POST /price/:token,
  //     JSON marginOverride) and to preview must reject with the SAME semantics: both 400, and the
  //     save error contains the exact validateMargins reason the preview surfaces (the save path
  //     wraps it with an "invalid margin override:" prefix). This is the anti-drift pin: preview
  //     can never accept a band the save would reject.
  //     Mutation caught: preview validating margins with anything other than the shared
  //     validateMargins (e.g. a looser check that accepts a negative margin).
  // ============================================================================================
  {
    const rParity = await seed('PREV-PARITY');
    const badCost = 80000; // well above minPlausibleCost, so the low-cost confirm never interferes
    // Act
    const prev = await get(`/price/${rParity.id}/preview?cost=${badCost}&m=-5`);
    const save = await postJson(`/price/${rParity.id}`, { cost: badCost, marginOverride: { marginsPct: [-5], minMarginPct: -5 } });
    // Assert (same rejection semantics)
    ok(prev.status === 400 && save.status === 400, 'margins_save_parity: preview and save both reject with 400');
    ok(isErrorEnvelope(prev) && isErrorEnvelope(save), 'margins_save_parity: both return an { error:string } envelope');
    ok(prev.json && save.json && typeof prev.json.error === 'string' && save.json.error.includes(prev.json.error),
      'margins_save_parity: save error carries the SAME validateMargins reason preview surfaces');
    // and the parity path must not have mutated the request (rejection is before any write)
    const stillOpen = await requests.getByToken(rParity.id);
    ok(stillOpen && stillOpen.status === 'awaiting_price', 'margins_save_parity: rejected save left the request awaiting_price (no partial write)');
  }

  // ============================================================================================
  // 11) arm_parity_zero_drift - THE invariant. Arm a load with an explicit band, read the ARMED
  //     monitor's ladder from engine.snapshot(), then preview the exact same cost+margins. The
  //     preview ladder must deep-equal what the engine actually armed - both via the stored band
  //     (no ?m=) and via an explicit ?m= that reconstructs the same band.
  //     Mutation caught: any divergence between planPreview() and the arm-time _planFor() (a
  //     changed rung formula, a dropped floor rung, a different rung count on one side only).
  // ============================================================================================
  {
    const rArm = await seed('PREV-ARM');
    const armCost = 80000;
    // Arm through the real save path (JSON capture with a bid-level band override) so the engine
    // arms exactly as production does; the JSON response also echoes the armed ladder.
    // 5% sits below the default 6.3% minimum, so the desk confirms it.
    const cap = await postJson(`/price/${rArm.id}`, { cost: armCost, marginOverride: { marginsPct: [15, 10, 5], minMarginPct: 5 }, below_min_ack: '1' });
    ok(cap.status === 200 && cap.json && cap.json.ok, 'arm_parity_zero_drift: JSON capture armed the load (200 ok)');

    // Read the armed ladder straight from the engine snapshot (source of truth for "what fires").
    const snap = engine.snapshot().find((m) => String(m.auctionId) === String(rArm.loadId));
    ok(snap && isNumberArray(snap.ladder), 'arm_parity_zero_drift: engine snapshot exposes the armed ladder');
    const armed = snap ? snap.ladder : null;

    // Preview using the STORED band (no ?m=) - must equal the armed ladder.
    const prevStored = await get(`/price/${rArm.id}/preview?cost=${armCost}`);
    ok(prevStored.status === 200, 'arm_parity_zero_drift: preview (stored band) -> 200');
    ok(armed && prevStored.json && JSON.stringify(prevStored.json.ladder) === JSON.stringify(armed),
      'arm_parity_zero_drift: preview(stored band) ladder deep-equals the armed monitor ladder');

    // Preview using an EXPLICIT ?m= that reconstructs the armed band - must also equal.
    const prevExplicit = await get(`/price/${rArm.id}/preview?cost=${armCost}&m=15,10,5`);
    ok(prevExplicit.status === 200, 'arm_parity_zero_drift: preview (explicit ?m=) -> 200');
    ok(armed && prevExplicit.json && JSON.stringify(prevExplicit.json.ladder) === JSON.stringify(armed),
      'arm_parity_zero_drift: preview(explicit ?m=) ladder deep-equals the armed monitor ladder');
    // floor + rungCount must agree with the armed ladder too, not just the ladder array
    ok(armed && prevExplicit.json && prevExplicit.json.floor === armed[armed.length - 1],
      'arm_parity_zero_drift: preview floor === armed floor rung');
    ok(armed && prevExplicit.json && prevExplicit.json.rungCount === armed.length,
      'arm_parity_zero_drift: preview rungCount === armed rung count');
  }

  // ============================================================================================
  // 12) no_state_mutation - preview is read-only. Call it 5x with varying params and confirm it
  //     creates no monitor for the load and does not alter the stored price-request record.
  //     Mutation caught: preview accidentally arming/persisting (calling arm/capture instead of
  //     planPreview).
  // ============================================================================================
  {
    const rRO = await seed('PREV-READONLY');
    const beforeDoc = JSON.stringify(await requests.getByToken(rRO.id));
    const beforeMonitors = engine.snapshot().filter((m) => String(m.auctionId) === String(rRO.loadId)).length;

    // Act - 5 varied calls (valid, valid+m, invalid cost, invalid m, valid again)
    await get(`/price/${rRO.id}/preview?cost=25000`);
    await get(`/price/${rRO.id}/preview?cost=25000&m=12,8,6`);
    await get(`/price/${rRO.id}/preview?cost=-1`);
    await get(`/price/${rRO.id}/preview?cost=25000&m=abc`);
    await get(`/price/${rRO.id}/preview?cost=31000`);

    const afterDoc = JSON.stringify(await requests.getByToken(rRO.id));
    const afterMonitors = engine.snapshot().filter((m) => String(m.auctionId) === String(rRO.loadId)).length;

    // Assert
    ok(beforeMonitors === 0 && afterMonitors === 0, 'no_state_mutation: preview created no engine monitor for the load');
    ok(beforeDoc === afterDoc, 'no_state_mutation: preview left the stored price-request record byte-identical');
  }

  // ============================================================================================
  // 13) content_type - both a 200 and a 400 are application/json (error envelope + success share
  //     the JSON content type). Mutation caught: an error path that sends text/html instead of JSON.
  // ============================================================================================
  {
    const okResp = await get(`/price/${rGate.id}/preview?cost=18000`);
    const badResp = await get(`/price/${rGate.id}/preview?cost=0`);
    ok(okResp.status === 200 && jsonCT(okResp), 'content_type: 200 response is application/json');
    ok(badResp.status === 400 && jsonCT(badResp), 'content_type: 400 response is application/json');
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
