'use strict';
/**
 * Pins C078 (fix/ops-alerting-divergences).
 *
 * The GoComet credential-expiry ladder, the adapter-registration failure alarm, the
 * stack-construction failure alarm, the rehydrate alarms, and the adapter's own auth-dead alarm
 * (_alertOps) all carry platformKey 'gocomet', so Notifier._whatsapp resolved their channel via
 * notifyModeFor('gocomet') - the SAME per-LOAD noise setting (gocometNotifyMode, default
 * 'dashboard') that exists only to control GoComet load messages. Flipping that load-noise
 * setting silently took the whole credential/health alarm ladder down with it. These are now
 * tagged with notifyModeOverride: 'whatsapp' so they reach WhatsApp regardless of
 * gocometNotifyMode - genuine per-load GoComet messages (which carry no such override) are
 * untouched and still gate on it.
 *
 * @requires-summary-line
 *   node scripts/test-c078-gocomet-ops-alarms-reach-whatsapp.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Notifier } = require('../src/notify/notifier');
const { MemoryStore } = require('../src/store/memoryStore');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { checkTokenExpiry } = require('../src/notify/tokenExpiry');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

function makeNotifier(gocometMode) {
  const sends = [];
  const wa = {
    enabled: () => true,
    sessionHealthy: async () => true,
    sendText: async (to, message, opts) => { sends.push({ to, message, kind: opts && opts.kind }); return { ok: true, messageId: `m${sends.length}` }; },
  };
  const n = new Notifier({
    mode: 'whatsapp', platformModes: { gocomet: gocometMode }, baseUrl: 'http://box', log: () => {},
    wa, store: new MemoryStore(),
    recipientsProvider: async () => [{ name: 'Ops', phone: '+919000000001', alerts: ['error'] }],
  });
  return { n, sends };
}

(async () => {
  // ---- control: gocometNotifyMode='dashboard' still gates a genuine GoComet payload with no override ----
  {
    const { n, sends } = makeNotifier('dashboard');
    await n.alert('error', { context: 'gocomet', platformKey: 'gocomet', detail: 'a plain gocomet error, no override' }, { dedupeKey: 'ctrl-1' });
    assert.strictEqual(sends.length, 0, 'control: an un-overridden GoComet-tagged alert still respects gocometNotifyMode=dashboard');
    ok('control: gocometNotifyMode continues to gate a payload that carries no override');
  }

  // ---- C078: an ops alarm with notifyModeOverride reaches WhatsApp even under dashboard mode ----
  {
    const { n, sends } = makeNotifier('dashboard');
    await n.alert('error', { context: 'gocomet', platformKey: 'gocomet', notifyModeOverride: 'whatsapp',
      detail: 'GoComet stack could not be built: boom' }, { dedupeKey: 'ops-1' });
    assert.strictEqual(sends.length, 1, 'C078: an ops-alarm-shaped alert with notifyModeOverride reaches WhatsApp under gocometNotifyMode=dashboard');
    ok('C078: notifyModeOverride bypasses the per-load gocometNotifyMode gate');
  }

  // ---- GoCometAdapter._alertOps (auth-dead / credential alarm) carries the override ----
  {
    const seen = [];
    const notifier = { alert: (kind, data, opts) => { seen.push({ kind, data, opts }); return Promise.resolve(); } };
    const a = new GoCometAdapter({ token: null, notifier });
    a._alertAuth('token expired');
    assert.strictEqual(seen.length, 1, 'the auth alert fired');
    assert.strictEqual(seen[0].data.notifyModeOverride, 'whatsapp', 'C078: GoCometAdapter._alertOps tags its alert with notifyModeOverride');
    ok('GoCometAdapter._alertOps (credential/auth alarm) carries notifyModeOverride');
  }

  // ---- tokenExpiry: the GoComet caller (server.js expiryArgs) sets notifyModeOverride; SP does not ----
  {
    const expirySeen = [];
    const expiryNotifier = { alert: (kind, data) => { expirySeen.push(data); return Promise.resolve(); } };
    const nowMs = 1786400000000;
    await checkTokenExpiry({
      tokenExp: nowMs + 2.5 * 86400000, notifier: expiryNotifier, accountLabel: 'gocomet',
      product: 'GoComet', tokenKind: 'gc-token', platformKey: 'gocomet', now: nowMs,
      notifyModeOverride: 'whatsapp',
    });
    assert.ok(expirySeen.length > 0 && expirySeen.every((d) => d.notifyModeOverride === 'whatsapp'),
      'C078: a GoComet expiry warning carries notifyModeOverride when the caller asks for it');
    ok('checkTokenExpiry threads notifyModeOverride into its admin alert payloads');

    expirySeen.length = 0;
    await checkTokenExpiry({
      tokenExp: nowMs + 2.5 * 86400000, notifier: expiryNotifier, accountLabel: 'primary', now: nowMs,
    });
    assert.ok(expirySeen.length > 0 && expirySeen.every((d) => !d.notifyModeOverride),
      'a SuperProcure caller that supplies no override keeps its own notifyMode as the real control (unaffected by this fix)');
    ok('checkTokenExpiry stays a no-op for callers that do not ask for the override (SuperProcure unaffected)');
  }

  // ---- server.js: the GoComet expiryArgs actually sets the override, so a future edit can't drop it ----
  {
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.js'), 'utf8');
    assert.ok(/accountLabel:\s*'gocomet'[\s\S]{0,250}?notifyModeOverride:\s*'whatsapp'/.test(serverSrc),
      'server.js GoComet expiryArgs sets notifyModeOverride');
    ok('C078: server.js wires notifyModeOverride into the GoComet token-expiry call site');
  }

  console.log(`\n${pass}/6 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
