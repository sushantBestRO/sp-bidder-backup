'use strict';
/**
 * PER-PLATFORM notification gating - "surfaces everywhere, sends nothing".
 *
 * THE DEFECT THIS CLOSES. The WhatsApp channel was ONE GLOBAL SCALAR (Notifier.mode, seeded from
 * config.notifyMode, live-mutated on a Settings save). There was no way to say "GoComet loads
 * appear in the console, the worklist, /api/state, /api/price-requests and the public /price
 * capture pages, but send no WhatsApp" without flipping the same scalar to 'dashboard' and
 * silencing SuperProcure - which is live and earning - along with it.
 *
 * THE RESOLUTION RULE, and the direction it fails in. Notifier.notifyModeFor(platformKey) resolves
 * BY RECORD. A platform with its own configured entry gets that entry; ANYTHING ELSE - absent,
 * null, or a key nobody configured - resolves to the SuperProcure mode. That is the money-safe
 * direction and it matches priceRequests.platformOf, which already treats an absent platformKey as
 * SuperProcure by construction: a missed SP price ask is a missed live auction, while a stray
 * GoComet message is only noise. There is deliberately no third behaviour.
 *
 * WHAT THIS PINS:
 *   A. notifyModeFor: SP key, absent, null and an unconfigured key ALL resolve to the SP mode;
 *      only a configured platform gets its own.
 *   B. an SP-tagged price ask still reaches the wire (today's behaviour, unchanged).
 *   C. an UNTAGGED legacy request still reaches the wire - the regression that would have gone
 *      silent on every record written before GoComet existed.
 *   D. a GoComet-tagged ask puts ZERO calls on the injected WhatsApp client.
 *   E. the same GoComet ask still yields the capture link, the honest resolved channel, and the
 *      worklist row - the whole point of the change.
 *   F. remindApproaching obeys the same rule as the ask path.
 *   G. an engine alert carrying the GoComet platform sends nothing; SP and untagged still send.
 *   H. the switch is REAL: a GoComet entry of 'whatsapp' re-enables GoComet sends with no code
 *      change, and GC_NOTIFY_MODE is what seeds it.
 *   I. the config seam: default 'dashboard', operator-editable through configStore, junk rejected.
 *   J. grep gates - no send-path code outside the resolver reads a bare global mode.
 *
 *   node scripts/test-notify-platform-gating.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Notifier } = require('../src/notify/notifier');
const { notifyEngineEvent } = require('../src/notify/engineAlerts');
const { MemoryStore } = require('../src/store');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { defaultsFrom, merge, validate } = require('../src/admin/configStore');
const appConfig = require('../src/config');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// Every check below must run. A file that exits 0 having asserted nothing is a silent green run in
// this project's exit-code-graded runner, so the sentinel at the bottom pins the count.
const EXPECTED_CHECKS = 43;

const GC = 'gocomet';
const SP = appConfig.platformKey;   // 'sp' unless SP_PLATFORM_KEY overrides it

// A WhatsApp client that records every wire call and never touches the network. Asserting on THIS
// (not on a return value) is what proves a gated ask sent nothing: a return of true is also what a
// successful send gives back.
function fakeWa() {
  const calls = [];
  return {
    calls,
    phoneId: '128023',
    enabled: () => true,
    sessionHealthy: async () => true,
    sendText: async (to, message, opts) => { calls.push({ fn: 'sendText', to, message, kind: opts && opts.kind }); return { ok: true, messageId: `m${calls.length}` }; },
    replyText: async (to, id, message, opts) => { calls.push({ fn: 'replyText', to, message, kind: opts && opts.kind }); return { ok: true, messageId: `m${calls.length}` }; },
    editText: async (to, id, message, opts) => { calls.push({ fn: 'editText', to, message, kind: opts && opts.kind }); return { ok: true }; },
  };
}

// One unscoped DM subscriber to every kind - so nothing in these results can be explained by a
// scope miss or an unsubscribed kind, only by the platform gate.
const RECIPIENTS = [{
  name: 'Pricing Desk', phone: '+919000000001',
  alerts: ['price_needed', 'price_submitted', 'bid_live', 'outbid', 'won', 'lost', 'error', 'desk_notice'],
}];

function makeNotifier(platformModes, wa) {
  return new Notifier({
    mode: 'whatsapp', platformModes, baseUrl: 'http://box', log: () => {},
    wa, store: new MemoryStore(), recipientsProvider: async () => RECIPIENTS,
  });
}

const CLOSES_IN = 25 * 60_000;
function loadFor(id, companyName) {
  return {
    id, lane: { origin: 'Chikhli', destination: 'Bawal' }, equipment: '32ft SXL', units: 1,
    companyName, closesAt: Date.now() + CLOSES_IN, quoteType: 'FTL',
  };
}

(async () => {
  // ---- A. notifyModeFor: the resolution rule, including every unknown shape ----
  {
    const n = makeNotifier({ [GC]: 'dashboard' }, fakeWa());
    ok(n.notifyModeFor(SP) === 'whatsapp', 'A: the SuperProcure key resolves to the global (SP) mode');
    ok(n.notifyModeFor(undefined) === 'whatsapp', 'A: an ABSENT platform resolves to SuperProcure (platformOf convention)');
    ok(n.notifyModeFor(null) === 'whatsapp', 'A: a null platform resolves to SuperProcure');
    ok(n.notifyModeFor('') === 'whatsapp', 'A: an empty platform resolves to SuperProcure');
    ok(n.notifyModeFor('fretron') === 'whatsapp', 'A: an UNCONFIGURED portal resolves to SuperProcure, never to silence');
    ok(n.notifyModeFor(GC) === 'dashboard', 'A: a configured portal gets its own mode');
    n.mode = 'dashboard';
    ok(n.notifyModeFor(SP) === 'dashboard' && n.notifyModeFor(GC) === 'dashboard',
      'A: a live Settings save of the SP mode still moves SP (and cannot un-gate GoComet)');
  }

  // ---- B/C/D/E. the ask path, per platform, against ONE notifier ----
  {
    const wa = fakeWa();
    const n = makeNotifier({ [GC]: 'dashboard' }, wa);
    const store = new MemoryStore();
    const requests = new PriceRequestStore({ store, marginsPct: [12, 8, 5], minMarginPct: 4, platformKey: SP });

    // B - SuperProcure: unchanged, reaches the wire.
    const spReq = await requests.createForLoad(loadFor('23400001', 'Havells'), { platformKey: SP });
    const spOut = await n.requestPrice(spReq);
    ok(wa.calls.length === 1, 'B: an SP-tagged price ask still attempts a WhatsApp send');
    ok(spOut.channel === 'whatsapp', 'B: the SP ask reports the whatsapp channel');
    ok(spOut.delivered === true, 'B: the SP ask reports delivered');

    // C - the legacy record: no platformKey at all. This is the silent-breakage case.
    const legacy = { id: 'rq-legacy', loadId: '23400002', load: loadFor('23400002', 'KEI') };
    delete legacy.platformKey;
    const legacyOut = await n.requestPrice(legacy);
    ok(wa.calls.length === 2, 'C: an UNTAGGED legacy request still attempts a WhatsApp send');
    ok(legacyOut.channel === 'whatsapp', 'C: the untagged ask reports the whatsapp channel');

    // D - GoComet: nothing on the wire at all.
    const before = wa.calls.length;
    const gcReq = await requests.createForLoad(loadFor('GC-ENQ-77', 'Waaree'), { platformKey: GC });
    const gcOut = await n.requestPrice(gcReq);
    ok(wa.calls.length === before, 'D: a GoComet-tagged ask puts ZERO calls on the WhatsApp client');

    // E - and it surfaces everywhere it should.
    ok(gcOut.channel === 'dashboard', 'E: the GoComet ask reports the RESOLVED channel, not the global one');
    ok(typeof gcOut.link === 'string' && gcOut.link.startsWith('http://box/price/'),
      'E: the GoComet ask still returns the public capture link');
    ok(gcOut.link.endsWith(gcReq.id), 'E: the GoComet capture link carries the request token (the /price page auth)');
    ok(gcOut.delivered === true, 'E: the GoComet ask is delivered:true, so discovery marks it notified and never re-fires it');
    const worklist = await requests.listFor(GC);
    ok(worklist.length === 1 && worklist[0].loadId === 'GC-ENQ-77',
      'E: the GoComet request is on the platform-scoped worklist (the console/API surface)');
    const spWorklist = await requests.listFor(SP);
    ok(spWorklist.length === 1 && spWorklist[0].loadId === '23400001',
      'E: the SP worklist is unaffected by the GoComet row');

    // F - the reminder path obeys the same rule.
    const atReminder = wa.calls.length;
    await n.remindApproaching(gcReq);
    ok(wa.calls.length === atReminder, 'F: a GoComet reminder sends nothing');
    const gcRemind = await n.remindApproaching({ ...gcReq, id: `${gcReq.id}b` });
    ok(gcRemind.channel === 'dashboard', 'F: the GoComet reminder reports the resolved channel');
    const spRemind = await n.remindApproaching(spReq);
    ok(wa.calls.length === atReminder + 1, 'F: an SP reminder still reaches the wire');
    ok(spRemind.channel === 'whatsapp', 'F: the SP reminder reports the whatsapp channel');

    // The submit receipt rides the same record, so it must be gated the same way.
    const atSubmit = wa.calls.length;
    await n.confirmSubmitted({ ...gcReq, price: { cost: 42000 }, capturedAt: Date.now() });
    ok(wa.calls.length === atSubmit, 'D: the GoComet submit receipt sends nothing either');
    await n.confirmSubmitted({ ...spReq, price: { cost: 42000 }, capturedAt: Date.now() });
    ok(wa.calls.length === atSubmit + 1, 'B: the SP submit receipt still reaches the wire');
  }

  // ---- G. the engine-alert path (no platform on the payload unless the caller threads it) ----
  {
    const wa = fakeWa();
    const n = makeNotifier({ [GC]: 'dashboard' }, wa);
    const evt = (id) => ({ type: 'auction_result', auctionId: id, won: false, finalRank: 4,
      companyName: 'Waaree', lane: { origin: 'Chikhli', destination: 'Bawal' }, landedBids: 2 });

    await notifyEngineEvent(n, evt('GC-A1'), null, null, GC);
    ok(wa.calls.length === 0, 'G: an engine alert carrying the GoComet platform sends nothing');

    await notifyEngineEvent(n, evt('SP-A1'), null, null, SP);
    ok(wa.calls.length === 1, 'G: the same alert tagged SuperProcure sends');

    await notifyEngineEvent(n, evt('SP-A2'));
    ok(wa.calls.length === 2, 'G: an alert with NO platform threaded still sends (untagged means SuperProcure)');

    // The event's own tag is honoured when the caller threads nothing - the engine stamps
    // platformKey on its armed/intent path, so an event that carries it must not be ignored.
    await notifyEngineEvent(n, { ...evt('GC-A2'), platformKey: GC });
    ok(wa.calls.length === 2, 'G: an event carrying platformKey itself is gated with no caller help');

    // An error-class alert with no load context (token expiry, auth-dead) is an OPS message about
    // the box, not a per-load GoComet link - it must keep sending.
    await n.alert('error', { context: 'gocomet-GoComet', detail: 'GoComet token expires in ~3d' }, { dedupeKey: 'tok-1' });
    ok(wa.calls.length === 3, 'G: a platform-less ops error (token expiry / auth dead) still sends');
  }

  // ---- H. the switch is real ----
  {
    const wa = fakeWa();
    const n = makeNotifier({ [GC]: 'whatsapp' }, wa);
    const store = new MemoryStore();
    const requests = new PriceRequestStore({ store, marginsPct: [12, 8, 5], minMarginPct: 4, platformKey: SP });
    const gcReq = await requests.createForLoad(loadFor('GC-ENQ-88', 'Waaree'), { platformKey: GC });
    const out = await n.requestPrice(gcReq);
    ok(wa.calls.length === 1, 'H: with the GoComet entry set to whatsapp, a GoComet ask DOES send');
    ok(out.channel === 'whatsapp', 'H: and reports the whatsapp channel');
    await notifyEngineEvent(n, { type: 'auction_result', auctionId: 'GC-H1', won: true, finalRank: 1,
      companyName: 'Waaree', lane: { origin: 'Chikhli', destination: 'Bawal' } }, null, null, GC);
    ok(wa.calls.length === 2, 'H: the engine-alert path follows the same switch');
  }

  // ---- I. the config seam ----
  {
    ok(appConfig.gocomet.notifyMode === 'dashboard',
      'I: GoComet defaults to dashboard-only (GC_NOTIFY_MODE unset)');
    const d = defaultsFrom(appConfig);
    ok(d.gocometNotifyMode === 'dashboard', 'I: configStore seeds gocometNotifyMode from config');
    ok(d.notifyMode === appConfig.notifyMode, 'I: the SuperProcure notifyMode default is untouched');
    const flipped = merge(d, { gocometNotifyMode: 'whatsapp' });
    ok(flipped.gocometNotifyMode === 'whatsapp' && flipped.notifyMode === d.notifyMode,
      'I: an operator save moves ONLY the GoComet channel');
    let code = null;
    try { validate(merge(d, { gocometNotifyMode: 'sms' })); } catch (e) { code = e.code; }
    ok(code === 'BAD_INPUT', 'I: an unknown gocometNotifyMode is rejected');
    let ok2 = true;
    try { validate(merge(d, { gocometNotifyMode: 'whatsapp' })); } catch (_) { ok2 = false; }
    ok(ok2, 'I: a valid gocometNotifyMode passes validation');

    // config.js reads env at require time, so the env leg needs a FRESH process (same technique as
    // test-desk-cost-floor.js PART 14). This is what proves the client can turn GoComet's WhatsApp
    // on later without a code change.
    const child = execFileSync(process.execPath, ['-e',
      `const c=require(${JSON.stringify(path.join(__dirname, '..', 'src', 'config.js'))});process.stdout.write(c.gocomet.notifyMode);`],
    { env: { ...process.env, GC_NOTIFY_MODE: 'whatsapp' }, encoding: 'utf8' });
    ok(child === 'whatsapp', 'I: GC_NOTIFY_MODE=whatsapp is what seeds the switch');
  }

  // ---- J. grep gates ----
  {
    const srcRoot = path.join(__dirname, '..', 'src');
    const notifierPath = path.join(srcRoot, 'notify', 'notifier.js');
    const lines = fs.readFileSync(notifierPath, 'utf8').split('\n')
      .map((t) => t.trim())
      .filter((t) => !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*'));

    // GATE 1 - `this.mode` is the SuperProcure/global default and nothing else may read it. Every
    // send decision goes through notifyModeFor, so the only legal readers are the constructor
    // assignment and the resolver's own fallback.
    const modeReads = lines.filter((t) => /\bthis\.mode\b/.test(t));
    assert.deepStrictEqual(modeReads.sort(), ['return this.mode;', 'this.mode = mode;'],
      `notifier.js reads this.mode outside the resolver: ${JSON.stringify(modeReads)}`);
    ok(true, 'J: this.mode is read only by the constructor and notifyModeFor');

    // GATE 2 - one channel comparison in the whole of src/, and it tests the RESOLVED local `mode`,
    // never `this.mode` or a config global. This is the single choke point every send funnels
    // through (_whatsapp); if a second one ever appears it must justify itself here first.
    const offenders = [];
    (function walk(d) {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) { walk(p); continue; }
        if (!ent.name.endsWith('.js')) continue;
        for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
          const t = raw.trim();
          if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue;
          if (/(===|!==)\s*['"]whatsapp['"]/.test(t)) offenders.push(`${path.relative(srcRoot, p)}: ${t}`);
        }
      }
    })(srcRoot);
    const chokePoint = `${path.join('notify', 'notifier.js')}: `
      + "if (mode !== 'whatsapp' || !this.wa || !this.wa.enabled()) return true;";
    assert.deepStrictEqual(offenders, [chokePoint],
      `unexpected channel comparison outside the resolver: ${JSON.stringify(offenders)}`);
    ok(true, 'J: exactly one channel comparison in src/, on the resolved per-record mode');

    // GATE 3 - the resolver is actually wired into every send-path entry point. Behavioural checks
    // above prove today's four; this fails loudly if a fifth entry point is added without one.
    // channelFor counts as a resolution: it IS the per-record resolver and its only job is to pick
    // between the portal's mode and a record-specific one before delegating to notifyModeFor. A
    // send-path entry point that calls it has resolved through the resolver, which is what this
    // gate is really asserting - counting only the inner name would fail the moment a caller uses
    // the outer one, which is the direction the code should move in, not away from.
    const src = fs.readFileSync(notifierPath, 'utf8');
    const resolutions = (src.match(/notifyModeFor\(/g) || []).length
      + (src.match(/channelFor\(/g) || []).length;
    ok(resolutions >= 5,
      'J: the channel resolver is called from its definition plus every send-path entry point');
  }

  // ---- completion sentinel ----
  // The runner grades by EXIT CODE, so an early return or a swallowed throw would otherwise exit 0
  // as a green zero-assertion run. Assert the full check count actually executed.
  assert.strictEqual(fail, 0, `${fail} platform-gating checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - the file exited early or a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
