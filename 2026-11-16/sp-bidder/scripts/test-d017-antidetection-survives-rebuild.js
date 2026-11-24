'use strict';
/**
 * Pins D017 (fix/ops-alerting-divergences).
 *
 * applyConfigValues sweeps every engine that ALREADY EXISTS when it runs, but a rebuilt account
 * stack (rebuildAccountStack -> buildRealStack -> makeEngine, e.g. after a reconnect) or the
 * GoComet engine (attachGoCometStack -> makeEngine, which runs AFTER boot's one
 * applyConfigValues call) is built LATER and never went through that sweep - it started on
 * BidEngine's own construction defaults (openJitterMs 0, cadenceJitterMs 250) until the next
 * Settings save. Fixed by having makeEngine apply the last-saved anti-detection settings to
 * every engine it builds, not only the ones that existed at the moment of a save.
 *
 * @requires-summary-line
 *   node scripts/test-d017-antidetection-survives-rebuild.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-d017-'));

const { makeEngine, applyConfigValues } = require('../src/web/server');
const { defaultsFrom } = require('../src/admin/configStore');
const config = require('../src/config');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

const fakeAdapter = () => ({ capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, closeModel: 'hard' }), writeEnabled: false });
const fakeScheduler = () => ({
  persist: () => {}, remove: () => {}, rehydrate: () => [], hadLoadError: () => false,
});
const stackRef = () => ({ tag: null });

// ---- control: before any config save, a freshly built engine carries BidEngine's own defaults ----
{
  const eng = makeEngine(fakeAdapter(), fakeScheduler(), stackRef());
  ok(eng.cfg.openJitterMs === 0, 'control: with no save yet, a new engine starts on BidEngine\'s own openJitterMs default (0)');
}

// ---- D017: after a Settings save, a NEWLY built engine (simulating a reconnect rebuild or the
// GoComet stack attaching after boot's applyConfigValues) must carry the saved settings, not the
// construction defaults ----
{
  const saved = defaultsFrom(config);
  saved.antiDetection = { enabled: true, cadenceJitterMs: 777, openJitterMs: 3333, maxBidsPerMin: 12, minInterFireMs: 140 };
  applyConfigValues(saved); // this is what a Settings save (or boot's configStore.get() apply) does

  const rebuilt = makeEngine(fakeAdapter(), fakeScheduler(), stackRef());
  ok(rebuilt.cfg.openJitterMs === 3333, 'D017: a rebuilt engine picks up the saved openJitterMs, not the construction default');
  ok(rebuilt.cfg.cadenceJitterMs === 777, 'D017: a rebuilt engine picks up the saved cadenceJitterMs');
  ok(rebuilt.cfg.maxBidsPerMin === 12, 'D017: a rebuilt engine picks up the saved maxBidsPerMin');
  ok(rebuilt.cfg.minInterFireMs === 140, 'D017: a rebuilt engine picks up the saved minInterFireMs');
}

// ---- enabled=false still forces the two jitters to 0 on a freshly built engine, same as setAntiDetection ----
{
  const saved = defaultsFrom(config);
  saved.antiDetection = { enabled: false, cadenceJitterMs: 500, openJitterMs: 5000, maxBidsPerMin: 15, minInterFireMs: 100 };
  applyConfigValues(saved);

  const rebuilt = makeEngine(fakeAdapter(), fakeScheduler(), stackRef());
  ok(rebuilt.cfg.openJitterMs === 0 && rebuilt.cfg.cadenceJitterMs === 0,
    'D017: anti-detection disabled still zeroes both jitters on a freshly built engine');
  ok(rebuilt.cfg.maxBidsPerMin === 15, 'the safety guards (not jitter) still carry through when disabled');
}

fs.rmSync(process.env.SP_DATA_DIR, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
