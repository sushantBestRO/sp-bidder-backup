'use strict';
/**
 * Pins C073 and C101 (fix/ops-alerting-divergences).
 *
 * C073: the heartbeat's accounts section is deliberately SuperProcure-only; no GoComet stack,
 * token, adapter-registration or poller-running check existed anywhere in the heartbeat.
 * collectGoComet() + a render block now cover token (via the account), adapter liveness, and the
 * poller, parallel to the SP accounts section - silent when GC is disabled (the common posture).
 *
 * C101: capabilities().livenessExpectedMs was declared and had zero consumers. GoCometAdapter now
 * stamps lastListSucceededAt on every successful (or rate-limited-partial) listAuctions(), and
 * collectGoComet compares "how long since the last success" against livenessExpectedMs to decide
 * live/silent.
 *
 * @requires-summary-line
 *   node scripts/test-c073-c101-heartbeat-gocomet-section.js
 */
const assert = require('assert');
const { collectGoComet, renderHeartbeat } = require('../src/notify/heartbeat');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const NOW = Date.now();

(async () => {
  // ---- C073: GC disabled (the common posture) is a clean no-op, not a "could not read" ----
  {
    const sec = await collectGoComet({ stacks: [], config: { gocomet: { enabled: false } } });
    assert.deepStrictEqual(sec, { ok: true, enabled: false }, `disabled GoComet collects cleanly: got ${JSON.stringify(sec)}`);
    ok('C073: a disabled GoComet posture collects as a clean, non-alarming section');
  }

  // ---- C073: enabled but never registered (no matching stack) is reported, not silently absent ----
  {
    const sec = await collectGoComet({ stacks: [], config: { gocomet: { enabled: true, platformKey: 'gocomet' } } });
    assert.strictEqual(sec.registered, false, `an enabled-but-unregistered GoComet reports registered:false, got ${JSON.stringify(sec)}`);
    ok('C073: GoComet enabled with no live stack is reported as unregistered');
  }

  // ---- C101: a live adapter (recent successful poll, well inside livenessExpectedMs) reports live:true ----
  {
    const stack = {
      platformKey: 'gocomet',
      discovery: { timer: {} },
      adapter: {
        account: { tokenExp: NOW + 30 * 86_400_000 },
        capabilities: () => ({ livenessExpectedMs: 60_000 }),
        lastListSucceededAt: NOW - 5_000, // 5s ago, well inside the 60s window
      },
    };
    const sec = await collectGoComet({ stacks: [stack], config: { gocomet: { enabled: true, platformKey: 'gocomet' } } });
    assert.strictEqual(sec.registered, true, 'a matching stack is reported as registered');
    assert.strictEqual(sec.pollerRunning, true, 'the poller timer being set reports pollerRunning:true');
    assert.strictEqual(sec.live, true, `C101: a recent successful poll inside livenessExpectedMs reports live:true, got ${JSON.stringify(sec)}`);
    ok('C101: an adapter with a recent successful poll (inside its own livenessExpectedMs) reports live');
  }

  // ---- C101: an adapter silent PAST livenessExpectedMs reports live:false, with the silent duration ----
  {
    const stack = {
      platformKey: 'gocomet',
      discovery: { timer: {} },
      adapter: {
        account: { tokenExp: NOW + 30 * 86_400_000 },
        capabilities: () => ({ livenessExpectedMs: 60_000 }),
        lastListSucceededAt: NOW - 10 * 60_000, // 10 minutes ago, past a 60s window
      },
    };
    // discoveryEnabled:true - review correction (26 Sep): this pins a genuine stall, so it must
    // stay distinguishable from a deliberate console pause, which suppresses this same alarm.
    const sec = await collectGoComet({ stacks: [stack], config: { gocomet: { enabled: true, platformKey: 'gocomet', discoveryEnabled: true } } });
    assert.strictEqual(sec.live, false, `C101: an adapter silent past livenessExpectedMs reports live:false, got ${JSON.stringify(sec)}`);
    assert.ok(sec.silentForMs >= 10 * 60_000 - 1000, 'reports roughly how long it has been silent');

    const rendered = renderHeartbeat({ gocomet: sec }, NOW);
    assert.ok(/GoComet adapter has not completed a successful read/.test(rendered),
      `C101: the render surfaces the silent adapter as an issue: got "${rendered}"`);
    ok('C101: a silent-past-window adapter reports live:false and the heartbeat surfaces it as an issue');
  }

  // ---- C073: the poller not running (while GC is enabled and registered) is surfaced as an issue ----
  {
    const stack = {
      platformKey: 'gocomet',
      discovery: { timer: null }, // not started
      adapter: {
        account: { tokenExp: NOW + 30 * 86_400_000 },
        capabilities: () => ({ livenessExpectedMs: 60_000 }),
        lastListSucceededAt: NOW - 5_000,
      },
    };
    // discoveryEnabled:true - review correction (26 Sep): this pins a genuine crash/never-started
    // poller, so it must stay distinguishable from a deliberate console pause (see below).
    const sec = await collectGoComet({ stacks: [stack], config: { gocomet: { enabled: true, platformKey: 'gocomet', discoveryEnabled: true } } });
    assert.strictEqual(sec.pollerRunning, false, 'a stopped poller (no timer) reports pollerRunning:false');
    const rendered = renderHeartbeat({ gocomet: sec }, NOW);
    assert.ok(/GoComet discovery poller is not running/.test(rendered),
      `C073: the render surfaces the stopped poller as an issue: got "${rendered}"`);
    ok('C073: a stopped GoComet poller is surfaced as a heartbeat issue');
  }

  // ---- never a fabricated verdict: no first successful poll yet reports live:null, no issue raised ----
  {
    const stack = {
      platformKey: 'gocomet',
      discovery: { timer: {} },
      adapter: {
        account: { tokenExp: NOW + 30 * 86_400_000 },
        capabilities: () => ({ livenessExpectedMs: 60_000 }),
        lastListSucceededAt: null, // fresh boot, no successful poll yet
      },
    };
    const sec = await collectGoComet({ stacks: [stack], config: { gocomet: { enabled: true, platformKey: 'gocomet' } } });
    assert.strictEqual(sec.live, null, `a fresh boot with no successful poll yet reports live:null, not a fabricated false: got ${JSON.stringify(sec)}`);
    const rendered = renderHeartbeat({ gocomet: sec }, NOW);
    assert.ok(!/has not completed a successful read/.test(rendered), 'no liveness issue is raised on an honest "not yet known" state');
    ok('control: an unknown (not-yet-observed) liveness state never fabricates an issue');
  }

  // ---- review correction (26 Sep): a DELIBERATE console pause (applyGoCometDiscovery(false)) must
  // not read as a false "not running" / "may be stuck" alarm - it is a stopped timer by design, and
  // a stale-poll silence is the expected consequence of a poller nobody is running right now.
  {
    const stack = {
      platformKey: 'gocomet',
      discovery: { timer: null }, // stopped BY THE CONSOLE TOGGLE, not a crash
      adapter: {
        account: { tokenExp: NOW + 30 * 86_400_000 },
        capabilities: () => ({ livenessExpectedMs: 60_000 }),
        lastListSucceededAt: NOW - 10 * 60_000, // stale too, as a paused poller naturally goes
      },
    };
    const sec = await collectGoComet({ stacks: [stack], config: { gocomet: { enabled: true, platformKey: 'gocomet', discoveryEnabled: false } } });
    assert.strictEqual(sec.pollerRunning, false, 'fixture: the poller is indeed stopped');
    const rendered = renderHeartbeat({ gocomet: sec }, NOW);
    assert.ok(/GoComet polling is paused/.test(rendered), `review correction: a deliberate pause reports "GoComet polling is paused": got "${rendered}"`);
    assert.ok(!/GoComet discovery poller is not running/.test(rendered), `a deliberate pause must not also fire "not running": got "${rendered}"`);
    assert.ok(!/may be stuck/.test(rendered), `a deliberate pause must not also fire "may be stuck": got "${rendered}"`);
    const pausedCount = (rendered.match(/GoComet polling is paused/g) || []).length;
    assert.strictEqual(pausedCount, 1, `the paused message appears exactly once, not stacked with the others: got ${pausedCount}`);
    ok('review correction: a deliberate console pause reports "GoComet polling is paused" once, never the not-running/may-be-stuck alarms');
  }

  // ---- control: the SAME stopped/stale shape with discovery genuinely enabled still alarms as before ----
  {
    const stack = {
      platformKey: 'gocomet',
      discovery: { timer: null },
      adapter: {
        account: { tokenExp: NOW + 30 * 86_400_000 },
        capabilities: () => ({ livenessExpectedMs: 60_000 }),
        lastListSucceededAt: NOW - 10 * 60_000,
      },
    };
    const sec = await collectGoComet({ stacks: [stack], config: { gocomet: { enabled: true, platformKey: 'gocomet', discoveryEnabled: true } } });
    const rendered = renderHeartbeat({ gocomet: sec }, NOW);
    assert.ok(/GoComet discovery poller is not running/.test(rendered), `control: with discovery genuinely enabled, a stopped poller still alarms: got "${rendered}"`);
    assert.ok(!/GoComet polling is paused/.test(rendered), `control: the paused wording never appears when discovery is enabled: got "${rendered}"`);
    ok('control: the not-running/may-be-stuck alarms are unaffected when the pause is not deliberate (discoveryEnabled: true)');
  }

  console.log(`\n${pass}/8 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
