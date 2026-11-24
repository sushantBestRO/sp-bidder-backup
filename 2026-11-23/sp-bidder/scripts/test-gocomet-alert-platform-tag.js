'use strict';
/**
 * A GoComet FAILURE must not reach the customer's WhatsApp group.
 *
 * Notifier.notifyModeFor resolves an untagged payload to SuperProcure. That default is deliberate
 * and money-safe for a price ask - a missed SuperProcure ask is a missed live auction - but it means
 * any GoComet alert that forgets `platformKey` is delivered over WhatsApp to a customer group. The
 * three GoComet failure paths (adapter auth, adapter registration, stack construction) all fire from
 * catch blocks whose whole purpose is that GoComet cannot break SuperProcure, so they are exactly the
 * paths nobody exercises before shipping.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { Notifier } = require('../src/notify/notifier');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const EXPECTED_CHECKS = 15;

(async () => {
  // ---- A. the adapter tags its own auth alert ------------------------------------------------
  const seen = [];
  const notifier = { alert: (kind, data, opts) => { seen.push({ kind, data, opts }); return Promise.resolve(); } };

  const a = new GoCometAdapter({ token: null, notifier });
  ok(a.platformKey === 'gocomet', 'A: the adapter carries its own platform key');
  a._alertAuth('token expired');
  ok(seen.length === 1, 'A: the auth alert fired');
  ok(seen[0].data.platformKey === 'gocomet', 'A: the auth alert carries platformKey');
  ok(seen[0].data.context === 'gocomet', 'A: the context literal is unchanged');

  const custom = new GoCometAdapter({ token: null, notifier, platformKey: 'gc2' });
  custom._alertAuth('x');
  ok(seen[1].data.platformKey === 'gc2', 'A: an overridden key reaches the alert, not a hardcoded literal');

  // ---- B. the notifier routes a tagged GoComet alert away from WhatsApp -----------------------
  const sends = [];
  const wa = { enabled: () => true, send: (...args) => { sends.push(args); return Promise.resolve({ ok: true }); } };
  const n = new Notifier({
    mode: 'whatsapp',
    platformModes: { gocomet: 'dashboard' },
    wa,
    recipientsProvider: async () => [{ phone: '911', kinds: ['error'] }],
  });

  ok(n.notifyModeFor('gocomet') === 'dashboard', 'B: a GoComet payload resolves to the console');
  ok(n.notifyModeFor('sp') === 'whatsapp', 'B: SuperProcure still resolves to WhatsApp');
  ok(n.notifyModeFor(null) === 'whatsapp', 'B: an UNTAGGED payload still resolves to SuperProcure (money-safe default preserved)');

  await n.alert('error', { context: 'gocomet', platformKey: 'gocomet', detail: 'boom' }, { dedupeKey: 'k1' });
  ok(sends.length === 0, 'B: a tagged GoComet failure sends no WhatsApp message');

  // ---- C. grep gate - every GoComet alert call site is tagged ---------------------------------
  // The three call sites live in two files and are only reachable from catch blocks, so a new one
  // added later would ship untested. Pin the property rather than the three known lines.
  const roots = [
    path.join(__dirname, '..', 'src', 'platform', 'gocometAdapter.js'),
    path.join(__dirname, '..', 'src', 'web', 'server.js'),
  ];
  const untagged = [];
  for (const f of roots) {
    const src = fs.readFileSync(f, 'utf8');
    // Each alert call is a single statement; match from `alert(` to the closing of its payload
    // object, then require platformKey inside it.
    const re = /\.alert\(\s*'[^']+'\s*,\s*\{([\s\S]{0,400}?)\}\s*,/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const payload = m[1];
      if (/context:\s*'gocomet'/.test(payload) && !/platformKey/.test(payload)) {
        untagged.push(`${path.basename(f)} @ index ${m.index}`);
      }
    }
  }
  ok(untagged.length === 0, `C: every context:'gocomet' alert carries platformKey (untagged: ${untagged.join('; ') || 'none'})`);

  // The gate must be capable of failing, or it proves nothing.
  const probe = "notifier.alert('error', { context: 'gocomet', detail: 'x' }, { dedupeKey: 'y' })";
  const probeRe = /\.alert\(\s*'[^']+'\s*,\s*\{([\s\S]{0,400}?)\}\s*,/;
  const pm = probeRe.exec(probe);
  ok(pm && /context:\s*'gocomet'/.test(pm[1]) && !/platformKey/.test(pm[1]),
    'C: the gate detects an untagged GoComet alert (negative control)');

  // ---- D. the token-expiry rail ---------------------------------------------------------------
  // tokenExpiry.js is shared by both portals and builds its `context` from a template, so the
  // literal-matching gate in C structurally cannot see it. It shipped untagged and a real GoComet
  // expiry warning went out on SuperProcure's channel before this was caught.
  const { checkTokenExpiry } = require('../src/notify/tokenExpiry');
  const expirySeen = [];
  const expiryNotifier = { alert: (kind, data) => { expirySeen.push(data); return Promise.resolve(); } };
  const nowMs = 1786400000000;

  await checkTokenExpiry({
    tokenExp: nowMs + 2.5 * 86400000, notifier: expiryNotifier, accountLabel: 'gocomet',
    product: 'GoComet', tokenKind: 'gc-token', platformKey: 'gocomet', now: nowMs,
  });
  ok(expirySeen.length > 0, 'D: the expiry rail fired');
  ok(expirySeen.every((d) => d.platformKey === 'gocomet'),
    'D: every expiry warning carries the platform key it was given');

  expirySeen.length = 0;
  await checkTokenExpiry({
    tokenExp: nowMs + 2.5 * 86400000, notifier: expiryNotifier, accountLabel: 'primary', now: nowMs,
  });
  ok(expirySeen.length > 0 && expirySeen.every((d) => d.platformKey == null),
    'D: a SuperProcure caller passes no key, so it keeps resolving to WhatsApp (default preserved)');

  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.js'), 'utf8');
  ok(/accountLabel:\s*'gocomet'[\s\S]{0,200}?platformKey/.test(serverSrc),
    "D: the GoComet expiry call site passes platformKey");

  assert.strictEqual(fail, 0, `${fail} alert-tagging checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - the file exited early or a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
