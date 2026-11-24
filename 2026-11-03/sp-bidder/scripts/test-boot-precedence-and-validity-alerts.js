'use strict';
/**
 * Pins D008, D010, D009 (fix/ops-alerting-divergences).
 *
 * D008: once a config document is saved, every persisted field silently wins over the
 *   env-derived default, with nothing logging the divergence. ConfigStore.onLoad must report
 *   which top-level fields diverged, once, the first time a persisted doc is loaded.
 * D010: SecretsVault.applyToEnv overlays stored tokens onto process.env (vault wins over
 *   .env) and the caller had no way to see which keys were overridden. applyToEnv must offer
 *   an onKey callback so the override is observable.
 * D009: ConfigStore.get() applies a persisted document whether or not it would pass
 *   validate()'s own rules, and nothing said so. onLoad must report validity, still return
 *   the (possibly invalid) merged document, and never throw - an invalid persisted config
 *   must never stop the bidder booting.
 *
 * Review correction (26 Sep): every section above drives ConfigStore's generic onLoad HOOK with a
 * test-local callback - it never once exercises server.js's own wiring (server.js ~322), the real
 * closure that calls baseLog.force and notifier.alert. The last section requires server.js itself
 * (mock mode, no real adapter/network) and seeds ITS OWN store/configStore, so the assertions are
 * against the shipped closure.
 * @requires-summary-line
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createStore } = require('../src/store');
const { ConfigStore, defaultsFrom } = require('../src/admin/configStore');
const { SecretsVault } = require('../src/store/secretsVault');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const baseConfig = {
  marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3,
  allowlist: { shippers: [], lanes: [], hardCloseOnly: false },
  discoveryIntervalMs: 30000, priceDeadlineLeadMs: 35000, reminderLeadMs: 60000, notifyMode: 'dashboard',
};

(async () => {
  // ---- D008: persisted-vs-default divergence is reported once, at first load ----
  {
    const defaults = defaultsFrom(baseConfig);
    const store = createStore({ backend: 'memory' });
    // Simulate an already-saved document (skip .save() so it is not itself run through validate() -
    // this is what a doc from a prior boot looks like to a fresh ConfigStore instance).
    const saved = Object.assign({}, defaults, { minMarginPct: 9.9, notifyMode: 'whatsapp' });
    await store.putDoc('config', 'current', saved);

    const cs = new ConfigStore({ store, defaults });
    let report = null;
    cs.onLoad = (info) => { report = info; };
    const g = await cs.get();
    ok(report !== null, 'onLoad fired on first get() of a persisted document');
    ok(report.diverged.includes('minMarginPct') && report.diverged.includes('notifyMode'),
      'D008: onLoad reports every field that diverges from the env default');
    ok(!report.diverged.includes('marginsPct'), 'D008: a field that matches the default is not reported as diverged');
    ok(g.minMarginPct === 9.9, 'the diverged value is still the one applied');

    // A second get() must not re-fire onLoad - it is the boot-time load that matters, not every read.
    let fired2 = false;
    cs.onLoad = () => { fired2 = true; };
    await cs.get();
    ok(!fired2, 'D008: onLoad does not re-fire on a cached repeat get()');
  }

  // ---- D008 edge: a fresh box (no persisted document) has nothing to diverge from ----
  {
    const defaults = defaultsFrom(baseConfig);
    const store = createStore({ backend: 'memory' });
    const cs = new ConfigStore({ store, defaults });
    let fired = false;
    cs.onLoad = () => { fired = true; };
    await cs.get();
    ok(!fired, 'D008: onLoad does not fire when there is no persisted document to diverge from');
  }

  // ---- D009: an invalid persisted document alerts but still boots ----
  {
    const defaults = defaultsFrom(baseConfig);
    const store = createStore({ backend: 'memory' });
    // discoveryIntervalMs < 5000 fails validate()'s own floor - a document that could not have been
    // saved through save() today (e.g. hand-edited, or saved under an older, looser rule).
    const badSaved = Object.assign({}, defaults, { discoveryIntervalMs: 1000 });
    await store.putDoc('config', 'current', badSaved);

    const cs = new ConfigStore({ store, defaults });
    let report = null;
    cs.onLoad = (info) => { report = info; };
    let g;
    let threw = false;
    try { g = await cs.get(); } catch (_) { threw = true; }
    ok(!threw, 'D009: an invalid persisted config never throws out of get() / never stops boot');
    ok(g.discoveryIntervalMs === 1000, 'D009: the invalid document is still applied, exactly as before the fix');
    ok(report.valid === false, 'D009: onLoad reports the document as invalid');
    ok(typeof report.error === 'string' && report.error.length > 0, 'D009: onLoad carries a reason');
  }

  // ---- D009: a valid persisted document reports valid, no alert-worthy signal ----
  {
    const defaults = defaultsFrom(baseConfig);
    const store = createStore({ backend: 'memory' });
    await store.putDoc('config', 'current', Object.assign({}, defaults, { discoveryIntervalMs: 45000 }));
    const cs = new ConfigStore({ store, defaults });
    let report = null;
    cs.onLoad = (info) => { report = info; };
    await cs.get();
    ok(report.valid === true && report.error === null, 'D009: a valid persisted document reports valid with no error');
  }

  // ---- D010: applyToEnv exposes which env keys a runtime-minted token overrode ----
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-test-'));
    const v = new SecretsVault({ dataDir });
    v.set('SP_TOKEN_PRIMARY', 'tok-abc');
    v.set('SP_TOKEN_SECONDARY', 'tok-def');

    const env = { SP_TOKEN_PRIMARY: 'stale-from-dotenv' };
    const seenKeys = [];
    const n = v.applyToEnv(env, { onKey: (k) => seenKeys.push(k) });
    ok(n === 2, 'D010: applyToEnv still returns the applied count unchanged');
    ok(seenKeys.sort().join(',') === 'SP_TOKEN_PRIMARY,SP_TOKEN_SECONDARY',
      'D010: onKey names every env var the vault overrode');
    ok(env.SP_TOKEN_PRIMARY === 'tok-abc', 'the vault value still wins over the stale .env value');

    // Backward compatible: calling with no options object at all must not throw.
    let threw = false;
    try { v.applyToEnv({}); } catch (_) { threw = true; }
    ok(!threw, 'D010: applyToEnv(env) with no options is still a valid call');

    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // ---- review correction: pin server.js's OWN configStore.onLoad wiring, not a stand-in ----
  {
    process.env.PLATFORM = 'mock';
    process.env.STORE_BACKEND = 'memory';
    delete process.env.SP_ADMIN_PASS_HASH;
    delete process.env.SP_SESSION_SECRET;
    const { store: realStore, configStore: realConfigStore, notifier: realNotifier } = require('../src/web/server');

    // A doc that is BOTH divergent (minMarginPct off the real default) AND invalid
    // (discoveryIntervalMs under validate()'s own floor) - one seed, both wiring paths.
    const realDefaults = realConfigStore.defaults;
    const seeded = Object.assign({}, realDefaults, {
      minMarginPct: Number(realDefaults.minMarginPct || 0) + 1,
      discoveryIntervalMs: 1000,
    });
    await realStore.putDoc('config', 'current', seeded);

    const alerts = [];
    const origAlert = realNotifier.alert.bind(realNotifier);
    realNotifier.alert = async (kind, payload, opts) => { alerts.push({ kind, payload, opts }); return origAlert(kind, payload, opts); };

    // baseLog.force/.warn route through console.error (src/logging/logger.js emit()), not
    // process.stdout.write - capture both streams so this is not coupled to that choice.
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const captureBoth = (into) => {
      process.stdout.write = (c, ...r) => { into.push(String(c)); return origOut(c, ...r); };
      process.stderr.write = (c, ...r) => { into.push(String(c)); return origErr(c, ...r); };
    };
    const restore = () => { process.stdout.write = origOut; process.stderr.write = origErr; };

    const chunks = [];
    captureBoth(chunks);
    let g;
    try { g = await realConfigStore.get(); } finally { restore(); }
    const logged = chunks.join('');

    ok(g.discoveryIntervalMs === 1000, 'fixture: server.js\'s real configStore applies the seeded (invalid) document');
    ok(/persisted config overrides the env default for:.*minMarginPct/.test(logged),
      `D008: server.js's real onLoad wiring actually LOGS the divergence (baseLog.force), not just the generic hook - saw: ${logged.slice(-400)}`);
    const invalidAlert = alerts.find((a) => a.kind === 'error' && a.payload && a.payload.context === 'config');
    ok(!!invalidAlert, `D009: server.js's real onLoad wiring actually calls notifier.alert on an invalid persisted config - alerts=${JSON.stringify(alerts.map((a) => a.kind))}`);
    ok(invalidAlert && invalidAlert.opts && invalidAlert.opts.dedupeKey === 'config_invalid_at_boot',
      'D009: the alert carries the fixed dedupeKey so a restart-loop on the same bad doc does not spam');

    // Control: a second get() (the cached path) must not re-log or re-alert.
    const alertsBefore = alerts.length;
    const chunks2 = [];
    captureBoth(chunks2);
    try { await realConfigStore.get(); } finally { restore(); }
    ok(alerts.length === alertsBefore, 'control: a cached repeat get() through server.js\'s real wiring does not re-alert');
    ok(!/persisted config overrides/.test(chunks2.join('')), 'control: a cached repeat get() does not re-log the divergence either');

    realNotifier.alert = origAlert;
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
