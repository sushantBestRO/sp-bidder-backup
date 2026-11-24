'use strict';
/**
 * A PARTIAL TRUCK COUNT IS NOT OFFERED ON A PORTAL THAT CANNOT SEND ONE.
 *
 * Found on live GoComet enquiry 2608125T8R (Waaree, Balwada -> Chikhli), whose `cargo_quantity` is
 * 187 - two orders of magnitude above every other observed enquiry, and a genuine truck count
 * (`cargo_unit` is TRUCK, and _mapEnquiry publishes `units` ONLY alongside that basis). The money
 * path handles it correctly: the wire carries the bare per-TRUCK price and GoComet's server
 * multiplies by its own `units`, so 187 changes the total and nothing else.
 *
 * What 187 broke was the PRICE PAGE. A multi-truck load renders "How many trucks to bid for
 * [187] / 187 trucks" as an EDITABLE control, and on a 187-truck enquiry lowering it to what BRL
 * can actually supply is the desk's most natural move. GoComet has no per-bid count field at all -
 * the count IS the quote's `units` and the server multiplies by it - so placeBid refuses a partial
 * outright (PARTIAL_VEHICLE_COUNT) rather than bidding for all 187 while the desk believed it had
 * asked for fewer. Every rung then throws before reaching the wire and the load closes with no bid,
 * off a cost the desk typed into a live page: the take-a-cost-then-discard-it shape
 * loadWillNotBid was written to keep off this page, arriving through a different door.
 *
 * The fix is a capability (never a portal-name test - MULTI_PLATFORM_ARCHITECTURE.md invariants 2
 * and 7) read at TWO seams, because either alone leaves a hole: the page, so the choice is not
 * offered, and armFromRequest, because a count captured before the portal declared itself - or
 * restored from a durable intent - reaches the engine without the page rendering again.
 *
 *   node scripts/test-gocomet-partial-count.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-gc-partial-'));

const http = require('http');
const assert = require('assert');
const { app, requests, stacks } = require('../src/web/server');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { surfaceCapabilityGaps } = require('../src/platform/gocometStack');
const { armFromRequest } = require('../src/pricing/priceRequests');

const EXPECTED_CHECKS = 26;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const validToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.`
  + `${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' })}.sig`;
const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

function req(method, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => resolve({ status: res.statusCode, text: buf })); });
    r.on('error', reject);
    r.end();
  });
}

const GC_ACCOUNT = 'gocomet-primary';
function pushGoCometStack() {
  const adapter = new GoCometAdapter({ token: null, bidEnabled: true });
  const stack = {
    account: { accountId: GC_ACCOUNT, label: 'GoComet' },
    tag: { accountId: GC_ACCOUNT, label: 'GoComet' },
    platformKey: 'gocomet',
    adapter,
    engine: { caps: adapter.capabilities(), snapshot: () => [], planPreview: () => ({ ladder: [13000, 12000, 11000], floor: 11000, rungCount: 3 }) },
  };
  const at = stacks.findIndex((s) => s.account && s.account.accountId === GC_ACCOUNT);
  if (at >= 0) stacks[at] = stack; else stacks.push(stack);
}

/** The count control's own markup, or '' - one <input id="vehicle_count" ...> tag. */
const countTag = (html) => { const m = /<input id="vehicle_count"[^>]*>/.exec(html); return m ? m[0] : ''; };

(async () => {
  // =====================================================================================
  // 1. THE CAPABILITY. Declared by both adapters, and its ABSENCE is caught at construction.
  // =====================================================================================
  console.log('\n1. the capability both portals now declare');
  {
    const gc = new GoCometAdapter({ token: null }).capabilities();
    ok(gc.partialVehicleCountSupported === false,
      'GoComet declares it cannot express a partial vehicle count');

    const sp = new RealSuperProcureAdapter({ token: 't' }).capabilities();
    // Settled 2026-08-05 over ~64,000 historical FTL bid rows: SuperProcure stores the count we
    // send rather than deriving it from the load, and 8 partial-count bids were allotted at that
    // count. The desk's editable control is a real choice there and must stay one.
    ok(sp.partialVehicleCountSupported === true,
      'SuperProcure declares it CAN - its FTL wire honours the vcq we send');

    // The stack's construction-time assert is the whole reason an omission cannot ship silently:
    // absent reads as "supported", which is the permissive direction.
    ok(surfaceCapabilityGaps(gc).length === 0,
      'the GoComet stack finds no surface-capability gap against the real adapter');
    const stripped = Object.assign({}, gc);
    delete stripped.partialVehicleCountSupported;
    ok(surfaceCapabilityGaps(stripped).includes('partialVehicleCountSupported'),
      'and it NAMES this key when an adapter stops declaring it');
  }

  // =====================================================================================
  // 2. THE ARM SEAM. The count is dropped where it cannot be sent - the belt that catches a
  //    record captured before the portal declared itself, and a restart's durable intent.
  // =====================================================================================
  console.log('\n2. the arm seam drops a count the portal cannot send');
  {
    const armedMeta = [];
    const engineWith = (caps) => ({
      caps,
      arm: (meta) => { armedMeta.push(meta); return { auctionId: meta.id, firedRungs: new Set() }; },
      schedule: (meta) => { armedMeta.push(meta); return null; },
    });
    const reqDoc = () => ({
      loadId: 'GC-187',
      load: {
        id: 'GC-187', units: 187, quoteType: 'FTL', lane: { origin: 'Balwada', destination: 'Chikhli' },
        equipment: '40 ft, 22 T', companyName: 'Waaree', status: 'live', closesAt: Date.now() + 600_000,
      },
      price: { cost: 12000, bidVehicleCount: 20 },
    });

    armFromRequest(engineWith({ biddingEnabled: true, partialVehicleCountSupported: false }), reqDoc());
    ok(armedMeta[0] && armedMeta[0].bidVehicleCount === null,
      'a persisted partial count is DROPPED on a portal that cannot express one (engine falls back to bid-max)');
    ok(armedMeta[0] && armedMeta[0].units === 187,
      '...and the load\'s own count still rides the meta, so the engine bids for all 187');

    armFromRequest(engineWith({ biddingEnabled: true, partialVehicleCountSupported: true }), reqDoc());
    ok(armedMeta[1] && armedMeta[1].bidVehicleCount === 20,
      'the desk\'s partial SURVIVES on a portal that can send one - SuperProcure is untouched');

    // Absent is TRUE, matching biddingEnabled's own rule: an adapter predating the field, and every
    // hand-rolled test double, must arm exactly as it does today.
    armFromRequest(engineWith({ biddingEnabled: true }), reqDoc());
    ok(armedMeta[2] && armedMeta[2].bidVehicleCount === 20,
      'an adapter that declares nothing keeps today\'s behaviour - absent is not false');
  }

  // =====================================================================================
  // 3. THE PAGE. The control is rendered, read-only, on a GoComet multi-truck load.
  // =====================================================================================
  console.log('\n3. the page a pricer opens on the 187-truck load');
  pushGoCometStack();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now();

  const pageFor = async (load, over = {}) => {
    const r = await requests.createForLoad({
      id: load.id, lane: { origin: 'Aspee Logipark, Balwada', destination: 'Degam, Chikhli' },
      equipment: '40 ft, 22 T', companyName: 'Waaree Energies', weight: 22, weightUnit: 'MT',
      closesAt: now + 20 * 60_000, startsAt: now - 60_000, status: 'live', softClose: true,
      closeModelKnown: true, ...load, ...over,
    }, { deadlineAt: now + 18 * 60_000, platformKey: load.platformKey || 'gocomet' });
    return { r, html: (await req('GET', `${base}/price/${r.id}`)).text };
  };

  {
    const { html } = await pageFor({
      id: 'GC-187', units: 187, quoteType: 'FTL',
      account: { accountId: GC_ACCOUNT, label: 'GoComet' },
    });
    const tag = countTag(html);
    ok(tag !== '', 'the count control still renders - the desk must SEE that this load is 187 trucks');
    ok(/\bdisabled\b/.test(tag), `and it is read-only (got ${JSON.stringify(tag.slice(0, 90))})`);
    ok(!/name="vehicle_count"/.test(tag),
      'it carries no name, so it can never POST a count the write path would refuse');
    ok(/value="187"/.test(tag), 'it shows the load\'s FULL count, which is what the bid commits to');
    ok(html.includes('/ 187 trucks'), 'the "/ N trucks" total still reads in trucks');
    ok(html.includes('Your cost PER TRUCK'),
      'the cost label still says PER TRUCK - the wire price is per truck and GoComet multiplies');
    // The MECHANISM sentence was cut (a fixed count beside a "/ 187 trucks" control changes
    // nothing the desk can do); the REMEDY is what survives, and it is what this pins.
    ok(!/no per-bid truck count/.test(html),
      'the page does not explain the portal mechanism beside a control that already shows the fixed count');
    ok(/quote this load by hand/i.test(html),
      '...and names the remedy, so a desk that needs fewer trucks is not simply stuck');
  }

  {
    // A persisted partial from before this shipped must not be displayed as though it will happen.
    const { r, html } = await pageFor({
      id: 'GC-187-STALE', units: 187, quoteType: 'FTL',
      account: { accountId: GC_ACCOUNT, label: 'GoComet' },
    });
    void html;
    // Exactly what the pre-fix page posted: a lowered count, recorded on the request.
    const capt = await requests.capture(r.id, { cost: 12000, bidVehicleCount: 20 });
    ok(capt.price.bidVehicleCount === 20, 'the pre-fix record really does carry the partial count');
    const again = (await req('GET', `${base}/price/${r.id}`)).text;
    ok(/value="187"/.test(countTag(again)),
      'a stale persisted partial renders as the FULL count - the page never states a commitment the engine will not make');
  }

  {
    // The single-truck case is untouched: no control at all, plain cost label.
    const { html } = await pageFor({
      id: 'GC-1', units: 1, quoteType: 'FTL',
      account: { accountId: GC_ACCOUNT, label: 'GoComet' },
    });
    ok(countTag(html) === '', 'a single-truck GoComet load renders no count control, exactly as before');
    ok(html.includes('Your cost (Rs)'), 'and the plain cost label, exactly as before');
  }

  {
    // NO REGRESSION ON SUPERPROCURE. The default stack's adapter declares nothing here, so absent
    // reads as supported and the control stays editable - the same load shape, the other portal.
    const { html } = await pageFor({ id: 'SP-3', units: 3, quoteType: 'FTL', platformKey: 'superprocure' });
    const tag = countTag(html);
    ok(tag !== '' && /name="vehicle_count"/.test(tag),
      'a multi-truck SuperProcure load keeps its EDITABLE count control');
    ok(!/\bdisabled\b/.test(tag), 'and is not disabled');
    ok(!/no per-bid truck count/.test(html), 'and carries no GoComet commitment note');
  }

  // =====================================================================================
  // 4. THE MONEY FACT 187 RESTS ON, pinned at 187 rather than at the captured 1 and 2.
  // =====================================================================================
  console.log('\n4. what actually goes on the wire at 187 units');
  {
    const puts = [];
    const quote = {
      id: 'Q187',
      charges_list: { '11_freight_charges': {
        freight_charges_custom_charge_40ft: { units: 187, unit_name: "TRUCK TON 22 40'X8'X8'8\") - (LXWXH 40FT", price: 1 },
      } },
      total_charges: { total: { units: 187.0, quote_units: 187.0, unit_name: 'TRUCK' } },
    };
    const fetchImpl = async (url, init) => {
      if (init.method === 'GET' && String(url).includes('/quotes')) return resp(200, [quote]);
      if (init.method === 'PUT') { puts.push(JSON.parse(init.body)); return resp(200, { data: { quote_rank: 2 } }); }
      return resp(404, {});
    };
    const a = new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl, sleep: async () => {} });
    await a.login();
    const r = await a.placeBid('GC-187', 12000, { floor: 11000, vcq: 187 });
    const line = puts[0].quote.charges_list['11_freight_charges'].freight_charges_custom_charge_40ft;
    ok(line.price === 12000,
      `the wire carries the BARE PER-TRUCK price, never the 187-truck total (got ${line.price})`);
    ok(r.units === 187 && r.wireTotal === 12000 * 187,
      `and the derived freight total is amount x units = ${12000 * 187} (got ${r.wireTotal})`);
    ok(r.unitName === 'TRUCK', 'on a basis validated as per-TRUCK, never assumed');
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed (${pass + fail}/${EXPECTED_CHECKS} checks reached the sentinel)`);
  // The completion sentinel. run-tests.js grades this file by EXIT CODE ONLY, so a file that
  // returned early would score a silent green having asserted nothing.
  ok(pass + fail === EXPECTED_CHECKS,
    `completion sentinel: ran ${pass + fail} checks, expected ${EXPECTED_CHECKS} (a check was skipped or added without updating EXPECTED_CHECKS)`);
  assert.strictEqual(fail, 0, `${fail} GoComet partial-count checks failed`);
})().catch((e) => { console.error(e); process.exit(1); });
