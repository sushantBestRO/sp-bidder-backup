'use strict';
/**
 * Pins D003 (fix/ops-alerting-divergences).
 *
 * No out-of-process check of the app itself existed - scripts/monitor-wa-sender.js's own
 * HEALTHCHECK_URL only proves the box and cron are alive, not that bid-command is up or discovery
 * is ticking. DiscoveryPoller now pings config.appHealthcheckUrl (env APP_HEALTHCHECK_URL) after
 * each GOOD discovery pass - off when unset, and a failed ping is logged, never thrown.
 *
 * Review correction (26 Sep): every poller pinged independently, so on a multi-account/multi-
 * platform box one healthy poller kept the switch alive while a different one sat dead with zero
 * ops signal. Pollers sharing a `healthcheckPeers` array (server.js builds ONE and passes it to
 * every stack) now register themselves onto it, and the ping only fires once EVERY peer has had a
 * good pass within its own interval - see the last section below.
 *
 * @requires-summary-line
 *   node scripts/test-d003-app-healthcheck-ping.js
 */
const assert = require('assert');
const { createStore } = require('../src/store');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { DiscoveryPoller } = require('../src/discovery/discovery');
const { Notifier } = require('../src/notify/notifier');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const mkPoller = (extra) => {
  const s = createStore({ backend: 'memory' });
  const rq = new PriceRequestStore({ store: s, marginsPct: [10], minMarginPct: 5 });
  const notifier = new Notifier({ mode: 'dashboard', baseUrl: 'http://t' });
  return new DiscoveryPoller({
    adapter: { listAuctions: async () => [] }, requests: rq, notifier,
    config: { allowlist: { shippers: [] } },
    ...extra,
  });
};

(async () => {
  // ---- unset: no ping, no error ----
  {
    let called = false;
    const p = mkPoller({ healthcheckFetch: async () => { called = true; return { ok: true }; } });
    await p.tick();
    assert.strictEqual(called, false, 'D003: with no healthcheckUrl configured, nothing is ever pinged');
    ok('D003: off by default (no URL configured) - never pings');
  }

  // ---- configured + a good pass: pinged ----
  {
    let calledWith = null;
    const p = mkPoller({
      healthcheckUrl: 'https://hc-ping.com/fake-uuid',
      healthcheckFetch: async (url, init) => { calledWith = { url, init }; return { ok: true }; },
    });
    await p.tick();
    assert.ok(calledWith, 'D003: a good discovery pass pings the configured healthcheck URL');
    assert.strictEqual(calledWith.url, 'https://hc-ping.com/fake-uuid', 'the exact configured URL is pinged');
    ok('D003: a good discovery pass pings the configured healthcheck URL');
  }

  // ---- a failed listing (bad pass) never pings ----
  {
    let called = false;
    const s = createStore({ backend: 'memory' });
    const rq = new PriceRequestStore({ store: s, marginsPct: [10], minMarginPct: 5 });
    const notifier = new Notifier({ mode: 'dashboard', baseUrl: 'http://t' });
    const p = new DiscoveryPoller({
      adapter: { listAuctions: async () => { throw new Error('simulated listing failure'); } },
      requests: rq, notifier, config: { allowlist: { shippers: [] } },
      healthcheckUrl: 'https://hc-ping.com/fake-uuid',
      healthcheckFetch: async () => { called = true; return { ok: true }; },
    });
    await p.tick();
    assert.strictEqual(called, false, 'D003: a FAILED listing pass never pings - it must not look like a heartbeat');
    ok('D003: a failed discovery pass (listAuctions threw) never pings, even with a URL configured');
  }

  // ---- a failed ping is swallowed, never thrown into the tick ----
  {
    let threw = false;
    const p = mkPoller({
      healthcheckUrl: 'https://hc-ping.com/fake-uuid',
      healthcheckFetch: async () => { throw new Error('simulated network failure'); },
    });
    let r;
    try { r = await p.tick(); } catch (_) { threw = true; }
    assert.strictEqual(threw, false, 'D003: a failed healthcheck ping must never break the discovery tick');
    assert.ok(r, 'the tick still completes and returns its normal result');
    ok('D003: a failed ping is caught and logged, never thrown into the tick');
  }

  // ---- shared peers (review correction): one dead poller withholds the ping for a healthy sibling ----
  {
    let called = false;
    const healthcheckFetch = async () => { called = true; return { ok: true }; };
    const healthcheckPeers = [];
    const healthyPoller = mkPoller({ healthcheckUrl: 'https://hc-ping.com/shared', healthcheckFetch, healthcheckPeers });
    healthyPoller.timer = {}; // named reversal (verification finding): a genuinely RUNNING poller has a live timer
    // The dead sibling shares the SAME array (so it is one of healthyPoller's peers) but is never
    // ticked - its _lastGoodTickAt stays null, exactly like a wedged/stuck poller in production.
    // Named reversal (verification finding, 26 Sep): .timer is set truthy here too - a wedged poller
    // in production still has its setInterval scheduled (only stop() clears it), so "never ticked
    // successfully" and "never started at all" (a paused GoComet poller) must be told apart by more
    // than _lastGoodTickAt alone, or the fix for one indistinguishably un-breaks the other.
    const deadSibling = mkPoller({ healthcheckUrl: 'https://hc-ping.com/shared', healthcheckFetch, healthcheckPeers });
    deadSibling.timer = {};
    assert.strictEqual(healthcheckPeers.length, 2, 'fixture: both pollers registered onto the shared array');
    await healthyPoller.tick();
    assert.strictEqual(called, false,
      'D003: a healthy poller must not ping while a sibling on the same healthcheckPeers array has never had a good pass');
    ok('D003: one dead peer withholds the ping even though this poller itself just had a good pass');
  }

  // ---- shared peers: once every peer has a recent good pass, the ping goes out ----
  {
    let called = false;
    const healthcheckFetch = async () => { called = true; return { ok: true }; };
    const healthcheckPeers = [];
    const pollerA = mkPoller({ healthcheckUrl: 'https://hc-ping.com/shared2', healthcheckFetch, healthcheckPeers });
    const pollerB = mkPoller({ healthcheckUrl: 'https://hc-ping.com/shared2', healthcheckFetch, healthcheckPeers });
    // Named reversal (verification finding, 26 Sep): both genuinely running (see the block above).
    pollerA.timer = {}; pollerB.timer = {};
    await pollerA.tick();
    assert.strictEqual(called, false, 'fixture: still withheld after only one of the two peers has ticked');
    await pollerB.tick();
    assert.strictEqual(called, true,
      'D003: once every peer sharing the URL has had a good pass, the (second, completing) tick pings it');
    ok('D003: the ping fires once every registered peer is current, not on the first one alone');
  }

  // ---- verification finding (26 Sep, case A): a paused GoComet poller (constructed, never
  // started - GC_DISCOVERY unset) must not block every OTHER poller's ping forever ----
  {
    let pings = 0;
    const healthcheckFetch = async () => { pings++; return { ok: true }; };
    const healthcheckPeers = [];
    const sp = mkPoller({ healthcheckUrl: 'https://hc/x', healthcheckFetch, healthcheckPeers });
    sp.timer = {}; // sp is genuinely running (SP pollers are always started)
    const gcPaused = mkPoller({ healthcheckUrl: 'https://hc/x', healthcheckFetch, healthcheckPeers });
    // gcPaused.timer is deliberately left null/unset - never start()ed, exactly like the GoComet
    // stack built with discoveryEnabled: false.
    assert.strictEqual(healthcheckPeers.length, 2, 'fixture: both pollers registered onto the shared array');
    await sp.tick(); await sp.tick(); await sp.tick();
    assert.ok(pings > 0, `verification finding: a paused (never-started) GoComet peer must not block SP's ping, got pings=${pings}`);
    ok('verification finding: a paused GoComet poller (no live timer) is excluded from the health check, not blocking a healthy sibling');
  }

  // ---- verification finding (26 Sep, case B): stop() removes a poller from the shared array, so an
  // SP reconnect's torn-down old poller does not silence the ping until the next restart ----
  {
    let pings = 0;
    const healthcheckFetch = async () => { pings++; return { ok: true }; };
    const healthcheckPeers = [];
    const old = mkPoller({ healthcheckUrl: 'https://hc/y', healthcheckFetch, healthcheckPeers });
    old.timer = {};
    await old.tick();
    const pingsBeforeStop = pings;
    assert.ok(pingsBeforeStop > 0, 'fixture: the original poller pinged fine before the reconnect');
    old.stop();
    assert.ok(!healthcheckPeers.includes(old), 'verification finding: stop() removes the poller from the shared healthcheckPeers array');
    const fresh = mkPoller({ healthcheckUrl: 'https://hc/y', healthcheckFetch, healthcheckPeers });
    fresh.timer = {};
    assert.strictEqual(healthcheckPeers.length, 1, 'fixture: only the fresh poller remains registered after the reconnect');
    await fresh.tick(); await fresh.tick(); await fresh.tick();
    assert.ok(pings > pingsBeforeStop, `verification finding: the fresh poller keeps pinging after a reconnect, without waiting for a restart, got pings=${pings}`);
    ok('verification finding: a torn-down (stopped) poller is removed from the shared array, so a reconnect keeps the ping alive');
  }

  console.log(`\n${pass}/8 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
