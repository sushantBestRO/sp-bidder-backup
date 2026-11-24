'use strict';
/**
 * Pins C074 (fix/ops-alerting-divergences).
 *
 * The GoComet token-expiry alerts said "Reconnect gocomet soon..." and "...reconnect the account
 * before it lapses" - wording that points at a self-serve reconnect page that does not exist for
 * GoComet (the console's reconnect routes are the SuperProcure OTP flow; GoComet has no row on
 * the Accounts page at all). The GoComet caller now supplies its own remedy phrase (update
 * GC_TOKEN and restart); SuperProcure's wording is unchanged.
 *
 * @requires-summary-line
 *   node scripts/test-c074-gocomet-expiry-copy-has-no-reconnect.js
 */
const assert = require('assert');
const { checkTokenExpiry } = require('../src/notify/tokenExpiry');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const nowMs = 1786400000000;
const jwt = (expMs) => 'h.' + Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000), user_id: 'u1' })).toString('base64') + '.s';

(async () => {
  // ---- GoComet: the short-lived rung message never says "reconnect" or names a page ----
  {
    const seen = [];
    const notifier = { alert: (kind, data) => { seen.push(data); return Promise.resolve(); } };
    await checkTokenExpiry({
      tokenExp: nowMs + 20 * 60 * 1000, notifier, accountLabel: 'gocomet', product: 'GoComet',
      tokenKind: 'gc-token', platformKey: 'gocomet', now: nowMs, tokenLifetimeMs: 8 * 3600 * 1000,
      shortRemedy: 'Get a fresh GoComet token (update GC_TOKEN) and restart the bot',
      longRemedy: 'get a fresh token (update GC_TOKEN) and restart the bot',
    });
    assert.ok(seen.length > 0, 'the short-lived rung fired');
    for (const d of seen) {
      assert.ok(!/reconnect/i.test(d.detail), `GoComet expiry copy must not say "reconnect": got "${d.detail}"`);
      assert.ok(/GC_TOKEN/.test(d.detail), `GoComet expiry copy names the actual remedy (GC_TOKEN): got "${d.detail}"`);
    }
    ok('C074: GoComet short-lived-rung expiry copy points at GC_TOKEN, never at a reconnect page');
  }

  // ---- GoComet: the day-threshold ladder message also avoids "reconnect" ----
  {
    const seen = [];
    const notifier = { alert: (kind, data) => { seen.push(data); return Promise.resolve(); } };
    await checkTokenExpiry({
      tokenExp: nowMs + 2.5 * 86400000, notifier, accountLabel: 'gocomet', product: 'GoComet',
      tokenKind: 'gc-token', platformKey: 'gocomet', now: nowMs,
      shortRemedy: 'Get a fresh GoComet token (update GC_TOKEN) and restart the bot',
      longRemedy: 'get a fresh token (update GC_TOKEN) and restart the bot',
    });
    assert.ok(seen.length > 0, 'the day-threshold ladder fired');
    for (const d of seen) {
      assert.ok(!/reconnect/i.test(d.detail), `GoComet day-threshold copy must not say "reconnect": got "${d.detail}"`);
      assert.ok(/GC_TOKEN/.test(d.detail), `GoComet day-threshold copy names GC_TOKEN: got "${d.detail}"`);
    }
    ok('C074: GoComet day-threshold expiry copy points at GC_TOKEN, never at a reconnect page');
  }

  // ---- control: SuperProcure's wording is byte-identical to before (a caller that passes no remedy) ----
  {
    const seen = [];
    const notifier = { alert: (kind, data) => { seen.push(data); return Promise.resolve(); } };
    await checkTokenExpiry({
      tokenExp: nowMs + 20 * 60 * 1000, notifier, accountLabel: 'primary', now: nowMs,
      tokenLifetimeMs: 8 * 3600 * 1000,
    });
    assert.ok(seen.some((d) => d.detail.startsWith('Reconnect primary soon')),
      `control: SuperProcure short-lived rung keeps its own "Reconnect <account>" wording: got ${JSON.stringify(seen.map((d) => d.detail))}`);
    ok('control: SuperProcure expiry copy is unchanged (still says "Reconnect")');
  }
  {
    const seen = [];
    const notifier = { alert: (kind, data) => { seen.push(data); return Promise.resolve(); } };
    await checkTokenExpiry({ tokenExp: nowMs + 2.5 * 86400000, notifier, accountLabel: 'primary', now: nowMs });
    assert.ok(seen.some((d) => /reconnect the account before it lapses/.test(d.detail)),
      `control: SuperProcure day-threshold copy is unchanged: got ${JSON.stringify(seen.map((d) => d.detail))}`);
    ok('control: SuperProcure day-threshold copy is unchanged (still says "reconnect the account")');
  }

  // ---- review correction (26 Sep): the ADAPTER'S OWN reactive auth alarms (login/ensureSession),
  // separate from the proactive checkTokenExpiry ladder above, still said "reconnect the account" -
  // a page GoComet has never had, now reaching WhatsApp directly (C078: _alertOps carries
  // notifyModeOverride). These drive the REAL methods, not a hand-typed detail string.
  {
    const seen = [];
    const notifier = { alert: (kind, data) => { seen.push(data); return Promise.resolve(); } };
    const a = new GoCometAdapter({ token: 'not-a-real-jwt', notifier });
    await a.login().catch(() => {});
    assert.ok(seen.length > 0, 'fixture: the malformed-token alarm fired');
    for (const d of seen) {
      assert.ok(!/reconnect/i.test(d.detail), `login() malformed-token alarm must not say "reconnect": got "${d.detail}"`);
      assert.ok(/GC_TOKEN/.test(d.detail), `login() malformed-token alarm names GC_TOKEN: got "${d.detail}"`);
    }
    ok('review correction: GoCometAdapter.login() malformed-token alarm points at GC_TOKEN, never a reconnect page');
  }
  {
    const seen = [];
    const notifier = { alert: (kind, data) => { seen.push(data); return Promise.resolve(); } };
    const a = new GoCometAdapter({ token: jwt(Date.now() - 3600_000), notifier }); // expired an hour ago
    await a.login().catch(() => {});
    assert.ok(seen.length > 0, 'fixture: the expired-token alarm fired');
    for (const d of seen) {
      assert.ok(!/reconnect/i.test(d.detail), `login() expired-token alarm must not say "reconnect": got "${d.detail}"`);
      assert.ok(/GC_TOKEN/.test(d.detail), `login() expired-token alarm names GC_TOKEN: got "${d.detail}"`);
    }
    ok('review correction: GoCometAdapter.login() expired-token alarm points at GC_TOKEN, never a reconnect page');
  }
  {
    const seen = [];
    const notifier = { alert: (kind, data) => { seen.push(data); return Promise.resolve(); } };
    const a = new GoCometAdapter({ token: jwt(Date.now() + 30_000), notifier }); // expires in 30s
    await a.login();
    seen.length = 0;
    await a.ensureSession().catch(() => {}); // now within the 60s pre-expiry window
    assert.ok(seen.length > 0, 'fixture: the near-expiry alarm fired');
    for (const d of seen) {
      assert.ok(!/reconnect/i.test(d.detail), `ensureSession() near-expiry alarm must not say "reconnect": got "${d.detail}"`);
      assert.ok(/GC_TOKEN/.test(d.detail), `ensureSession() near-expiry alarm names GC_TOKEN: got "${d.detail}"`);
    }
    ok('review correction: GoCometAdapter.ensureSession() near-expiry alarm points at GC_TOKEN, never a reconnect page');
  }

  console.log(`\n${pass}/7 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
