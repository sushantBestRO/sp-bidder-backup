'use strict';
/**
 * L3 SOFT-CLOSE CAPTURE SCOPE - regression for the gate that silently blocked the entire
 * soft-close rollout.
 *
 * The bug: discovery.matchesAllowlist admits an enrolled, VERIFIED soft load onto the pricing
 * worklist (it carries the `!_softAdmitted` carve-out) and the price link goes out - but the
 * capture-time scope backstop in the POST /price handler (server.js) checked only
 * `hardCloseOnly && isOutOfHardCloseScope(load)` and threw OUT_OF_SCOPE, MISSING the soft
 * carve-out. So the desk was invited to price a load it was then refused when it entered a cost,
 * and zero soft bids ever landed. The fix consolidates the predicate into one exported
 * `softAdmitted(sc, load)` shared by both gates and adds the carve-out to capture.
 *
 * Acceptance criterion is CONSISTENCY: a load discovery would admit via the soft path is a load
 * capture now accepts; a load discovery would reject, capture still rejects. Same predicate,
 * both gates.
 *
 *  A. The shared predicate (pure): softAdmitted's truth table, AND parity proof that the
 *     DiscoveryPoller._softAdmitted METHOD and the exported softAdmitted FUNCTION are one
 *     implementation (the method now just delegates).
 *  B. The REAL capture gate, driven end-to-end through the shipped POST /price handler:
 *     - enrolled + verified soft load (Havells)          -> ACCEPTED (armed), no OUT_OF_SCOPE
 *     - soft load whose shipper is NOT enrolled           -> still refused (409)
 *     - verified soft load with soft-close DISABLED live  -> still refused (409)
 *     - unverified load (closeModelKnown false)           -> still refused (409) even if enrolled
 *     - hard-close load                                   -> unchanged (accepted, armed)
 *
 * Section B exercises the actual server handler (not a re-implemented gate condition), so it pins
 * the shipped code path capture -> arm and proves the whole path is open for a Havells soft load.
 *
 *   node scripts/test-softclose-capture-scope.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_NOTIFY_MODE = 'dashboard';       // no WhatsApp send in a unit test
process.env.SP_HARD_CLOSE_ONLY = '1';           // scope gate ACTIVE - the whole point of this test
process.env.SP_SOFT_CLOSE_ENABLED = '1';        // master soft-close gate ON
process.env.SP_SOFT_CLOSE_SHIPPERS = 'Havells'; // Havells enrolled in the soft-close strategy
process.env.SP_SOFT_CLOSE_MODE = 'live';        // enrolled Havells soft loads bid for real (prod posture)
process.env.SP_MIN_PLAUSIBLE_COST = '1';        // keep the low-cost guard out of the way (real costs used anyway)

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-sc-capture-'));

const http = require('http');
const assert = require('assert');
const { app, requests, configStore } = require('../src/web/server');
const { DiscoveryPoller, softAdmitted } = require('../src/discovery/discovery');

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
const json = (obj) => JSON.stringify(obj);

(async () => {
  // ================= A. the shared predicate (pure) =================
  {
    const sc = { enabled: true, shippers: ['Havells'], mode: 'live' };
    // word-boundary tokenMatch means the enrolled token 'Havells' matches the full company name
    const softHavells = { companyName: 'Havells India Ltd', softClose: true, closeModelKnown: true };
    const softSyngenta = { companyName: 'Syngenta', softClose: true, closeModelKnown: true };
    const unverified = { companyName: 'Havells India Ltd', softClose: true, closeModelKnown: false };
    const hard = { companyName: 'Havells India Ltd', softClose: false, closeModelKnown: true };

    ok(softAdmitted(sc, softHavells) === true, 'softAdmitted: enrolled + verified soft load -> admitted');
    ok(softAdmitted(sc, softSyngenta) === false, 'softAdmitted: verified soft load, shipper NOT enrolled -> not admitted');
    ok(softAdmitted(sc, unverified) === false, 'softAdmitted: unverified close model -> not admitted even for an enrolled shipper (F8)');
    ok(softAdmitted({ enabled: false, shippers: ['Havells'] }, softHavells) === false, 'softAdmitted: master flag OFF -> not admitted');
    ok(softAdmitted({ enabled: true, shippers: [] }, softHavells) === false, 'softAdmitted: empty shipper list -> not admitted (opt-in, never blanket)');
    ok(softAdmitted(null, softHavells) === false, 'softAdmitted: absent soft-close block -> not admitted (fail closed)');
    ok(softAdmitted(sc, hard) === false, 'softAdmitted: a HARD load is not "soft-admitted" (its scope comes from the hard path, not this predicate)');

    // Parity: the DiscoveryPoller._softAdmitted METHOD and the exported softAdmitted FUNCTION are
    // one implementation. The method now delegates, so for every (config, load) pair they must agree
    // exactly - this is the "one implementation, proven" guarantee that keeps intake and capture in
    // lockstep. If they ever diverge, the two gates could drift apart again (the original bug).
    const cases = [
      [sc, softHavells], [sc, softSyngenta], [sc, unverified], [sc, hard],
      [{ enabled: false, shippers: ['Havells'] }, softHavells],
      [{ enabled: true, shippers: [] }, softHavells],
      [{ enabled: true, shippers: ['Rajratan'] }, softHavells],
    ];
    let allAgree = true;
    for (const [cfg, load] of cases) {
      const poller = new DiscoveryPoller({ config: { allowlist: { shippers: [], lanes: [], hardCloseOnly: true }, softClose: cfg } });
      if (poller._softAdmitted(load) !== softAdmitted(cfg, load)) allAgree = false;
    }
    ok(allAgree, 'parity: DiscoveryPoller._softAdmitted method === exported softAdmitted for every case (one implementation)');
  }

  // ================= B. the REAL capture gate (POST /price handler) =================
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now();
  // A live, biddable load. softClose/closeModelKnown/companyName vary per case; everything else fixed.
  const mkLoad = (id, over) => Object.assign({
    id, lane: { origin: 'Bhiwandi', destination: 'Vadodara' }, equipment: 'Dala Body LPT 14Ft', units: 1,
    companyName: 'Havells India Ltd', closesAt: now + 20 * 60_000, startsAt: now - 60_000,
    softClose: true, closeModelKnown: true, status: 'live',
  }, over || {});
  const capture = (id) => req('POST', `${base}/price/${id}`, { body: json({ cost: '22000' }), contentType: 'application/json' });

  // 1. enrolled + verified soft Havells load -> ACCEPTED (no OUT_OF_SCOPE), and it ARMS.
  {
    const r = await requests.createForLoad(mkLoad('SC-CAP-1'));
    const res = await capture(r.id);
    ok(res.status === 200 && res.json && res.json.ok === true, 'capture: enrolled + verified soft Havells load -> 200 accepted (NOT OUT_OF_SCOPE)');
    const after = await requests.getByToken(r.id);
    ok(after.status === 'armed' && after.price && after.price.cost === 22000, 'capture: the enrolled soft load ARMED (capture -> arm path is open)');
  }

  // 2. verified soft load whose shipper is NOT enrolled -> still refused.
  {
    const r = await requests.createForLoad(mkLoad('SC-CAP-2', { companyName: 'Syngenta' }));
    const res = await capture(r.id);
    ok(res.status === 409 && /scope/i.test((res.json && res.json.error) || res.text), 'capture: soft load, shipper NOT enrolled -> 409 OUT_OF_SCOPE (still refused)');
    const after = await requests.getByToken(r.id);
    ok(after.status === 'awaiting_price' && after.price == null, 'capture: the un-enrolled soft load did NOT arm');
  }

  // 3. verified, enrolled soft load but soft-close DISABLED at the LIVE config -> still refused.
  //    Flip the live setting via configStore (the same source the gate reads at capture time), prove
  //    the gate reads it live, then restore. This is why the handler reads liveCfg, not the token snapshot.
  {
    await configStore.save({ softClose: { enabled: false } });
    const r = await requests.createForLoad(mkLoad('SC-CAP-3'));
    const res = await capture(r.id);
    ok(res.status === 409 && /scope/i.test((res.json && res.json.error) || res.text), 'capture: enrolled soft load with soft-close DISABLED live -> 409 (still refused)');
    const after = await requests.getByToken(r.id);
    ok(after.status === 'awaiting_price' && after.price == null, 'capture: the soft load did NOT arm while soft-close was disabled');
    await configStore.save({ softClose: { enabled: true, shippers: ['Havells'], mode: 'live' } }); // restore
  }

  // 4. unverified close model (closeModelKnown false), shipper enrolled + enabled -> still refused (F8).
  {
    const r = await requests.createForLoad(mkLoad('SC-CAP-4', { closeModelKnown: false }));
    const res = await capture(r.id);
    ok(res.status === 409 && /scope/i.test((res.json && res.json.error) || res.text), 'capture: unverified close model -> 409 (still refused even for an enrolled shipper)');
    const after = await requests.getByToken(r.id);
    ok(after.status === 'awaiting_price' && after.price == null, 'capture: the unverified load did NOT arm');
  }


  // 5. Shyam Steel soft-close exception -> accepted and armed through POST /price.
  //    Shyam Steel is intentionally NOT in the Havells soft-close enrollment list.
  {
    const r = await requests.createForLoad(mkLoad('SC-CAP-SHYAM', {
      companyName: 'Shyam Steel',
      softClose: true,
      closeModelKnown: true,
    }));
    const res = await capture(r.id);
    ok(
      res.status === 200 && res.json && res.json.ok === true,
      'capture: Shyam Steel soft-close exception -> 200 accepted'
    );
    const after = await requests.getByToken(r.id);
    ok(
      after.status === 'armed' && after.price && after.price.cost === 22000,
      'capture: Shyam Steel exception ARMED the request'
    );
  }



  // 5. a hard-close load is unchanged by the fix -> accepted and armed exactly as before.
  {
    const r = await requests.createForLoad(mkLoad('SC-CAP-5', { softClose: false, closeModelKnown: true }));
    const res = await capture(r.id);
    ok(res.status === 200 && res.json && res.json.ok === true, 'capture: a confirmed hard-close load -> 200 accepted (unchanged)');
    const after = await requests.getByToken(r.id);
    ok(after.status === 'armed' && after.price && after.price.cost === 22000, 'capture: the hard-close load ARMED (unchanged behaviour preserved)');
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e && e.stack || e); process.exit(1); });
