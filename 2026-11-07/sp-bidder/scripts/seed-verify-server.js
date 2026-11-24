'use strict';
/**
 * Throwaway verification harness (not part of the test suite): boots the real app in mock
 * mode with a real admin hash, seeds one price-request per state this PR touches, prints the
 * URLs + an admin session cookie, and stays up so a Playwright script can screenshot each one.
 */
// env vars MUST be set before the first require of ../src/config (or anything that pulls it
// in transitively) - config.js reads process.env at module-load time and Node caches the
// module, so setting SP_ADMIN_PASS_HASH afterward has no effect on the cached config object.
const { hashPassword, signSession } = require('../src/auth/adminAuth');

const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_ADMIN_USER = 'admin';
process.env.SP_ADMIN_PASS_HASH = hashPassword('testpass');
process.env.SP_SESSION_SECRET = 'verify-secret-do-not-ship';
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-verify-'));

const config = require('../src/config');

const { app, requests } = require('../src/web/server');

(async () => {
  const server = app.listen(4399);
  await new Promise((r) => server.once('listening', r));
  const now = Date.now();
  const mkLoad = (id, closesInMs) => ({
    id, lane: { origin: 'Bhiwandi', destination: 'Bawal' }, equipment: 'Trailer', units: 1,
    companyName: 'Syngenta India', closesAt: now + closesInMs, startsAt: now - 60_000,
    softClose: false, status: 'live',
  });

  const rAwaiting = await requests.createForLoad(mkLoad('VER-awaiting', 20 * 60_000));

  const rDismissed = await requests.createForLoad(mkLoad('VER-dismissed', 20 * 60_000));
  await requests.dismiss(rDismissed.id);

  const rStopped = await requests.createForLoad(mkLoad('VER-stopped', 20 * 60_000));
  await requests.capture(rStopped.id, { cost: 80000 });
  await requests.stop(rStopped.id);

  const rLapsed = await requests.createForLoad(mkLoad('VER-lapsed', 3_000));
  await requests.capture(rLapsed.id, { cost: 80000 });
  await requests.stop(rLapsed.id);

  const rArmed = await requests.createForLoad(mkLoad('VER-armed', 20 * 60_000));
  await requests.capture(rArmed.id, { cost: 65000 });

  // weight-unit + distance fix (2026-07-11) - a KG-branch load (mirrors the real Ashirvad
  // Pipes incident: 2950.87 KG on a 19FT-SA-8MT truck), so the spec grid's Weight cell must
  // show "2950.87 KG" (never "MT") and a new Distance cell must show "235.58 km".
  const rSpecs = await requests.createForLoad({
    ...mkLoad('VER-specs', 20 * 60_000),
    companyName: 'Ashirvad Pipes Pvt Ltd', equipment: '19FT-SA-8MT',
    weight: 2950.87, weightUnit: 'KG', distanceKm: 235.58,
    productName: 'SWR FITTINGS SOLFIT', shipmentType: 'FTL',
  });

  const rClosed = await requests.createForLoad(mkLoad('VER-closed', 20 * 60_000));
  await requests.capture(rClosed.id, { cost: 55000 });

  const adminCookie = `sp_session=${signSession(config.admin.user, config.admin.sessionSecret, config.admin.sessionTtlMs)}`;

  // wait for VER-lapsed's closesAt to actually pass before printing (so the screenshot script
  // sees the lapsed/permanently-closed branch immediately, not a race against the clock)
  await new Promise((r) => setTimeout(r, 3200));

  console.log('READY');
  console.log(JSON.stringify({
    base: 'http://127.0.0.1:4399',
    adminCookie,
    urls: {
      awaiting_price: `/price/${rAwaiting.id}`,
      dismissed: `/price/${rDismissed.id}`,
      stopped_open: `/price/${rStopped.id}`,
      stopped_lapsed: `/price/${rLapsed.id}`,
      armed_reprice: `/price/${rArmed.id}`,
      specs_weight_distance: `/price/${rSpecs.id}`,
      closed: `/price/${rClosed.id}`,
      unknown_token: `/price/does-not-exist`,
      unknown_track: `/track/does-not-exist`,
      login_root: `/`,
    },
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
