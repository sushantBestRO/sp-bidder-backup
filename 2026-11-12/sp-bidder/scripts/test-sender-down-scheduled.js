'use strict';
/**
 * Sender-health gate for the SCHEDULED sends (offline). The failure this pins, confirmed live
 * 2026-07-24/25: the WhatsApp circuit breaker guarded ONLY the per-load alert path
 * (notifier._whatsapp). The two DAILY scheduled sends - the per-customer end-of-day report and
 * the morning heartbeat - go out through notifier.sendDirect, which USED TO bypass the breaker
 * entirely. So with the sender logged out, Maytapi accept-and-queued each onto the dead session
 * (returning ok:true) and the bot logged them "sent" while they waited to flood on re-link
 * (10 EOD group summaries + 3 heartbeat DMs queued on dead phoneId 128023 that night).
 *
 * The fix routes BOTH send paths through one per-CLASS health policy (Notifier._healthAction):
 *   - eod_report -> DROP when the sender is down (a stale end-of-day for a day that is over is
 *     worse than none; the numbers are on the dashboard and tomorrow's EOD is the fresh record);
 *   - heartbeat  -> REROUTE when down (deliver the SAME body through the Maytapi-independent
 *     channel - Brevo email + a healthy sibling phone - NEVER onto the dead sender, so the
 *     reader still hears the bot's non-sender issues without recreating the stale-queue).
 *
 * These assertions FAIL against the unpatched main (sendDirect POSTs unconditionally, so a
 * down-sender EOD lands one wire POST and the heartbeat lands one wire POST onto the dead
 * session) and PASS after the gate lands. The positive-guard and fail-open cases prove the gate
 * never OVER-blocks: a healthy sender still sends exactly one message per class, an unreadable
 * probe fails OPEN (sends), and a Notifier with no health provider is unchanged.
 *
 * Blocks (6)-(6d) additionally PIN the cross-PR policy decision for `director_eod` (PR #96's
 * ~20:10 IST Directors' participation DM). That kind is classified here BEFORE the code that sends
 * it exists, because the map's fail-safe default is 'drop' and 'drop' is the one wrong answer for
 * it - dropping means the Directors hear nothing on precisely the days the WhatsApp leg is broken,
 * and unlike the group eod_report there is no next-day edition that re-carries the missed day.
 */
const assert = require('assert');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier } = require('../src/notify/notifier');
const { MemoryStore } = require('../src/store');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const CREDS = { token: 't', productId: 'p', phoneId: '128023' };

// A transport that ACCEPTS-and-answers every sendMessage POST (Maytapi's ok:true on a dead
// session is exactly the hazard), and counts every wire call so a test can assert "nothing was
// POSTed onto the down sender". Mirrors test-wa-circuit-breaker.js's sendCapture().
function sendCapture() {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) }; };
  fn.calls = calls;
  return fn;
}

const HB_MSG = 'Bid Command: attention needed - WhatsApp alerts are not being delivered - the sender number is logged out.';
const EOD_MSG = '*Acme* - end of day: won 2 of 3';
// PR #96's director DM (the ~20:10 IST participation summary to the two Directors). Classified in
// HEALTH_POLICY here, ahead of its sender, because the map's default disposition is the wrong one
// for it - see the director_eod entry's rationale in src/notify/notifier.js.
const DIRECTOR_MSG = '*Today*: 12 loads came in, desk priced 9, we bid on 9.\n*Participation: 75%*';

(async () => {
  // ---- (1) eod_report + sender DOWN -> ZERO wire POSTs, a DROP result -----------------------
  // The headline regression: a stale end-of-day must never be queued onto the dead sender.
  {
    const tr = sendCapture();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const n = new Notifier({ mode: 'whatsapp', wa, store, healthProvider: async () => false });
    const res = await n.sendDirect('120363000000000000@g.us', EOD_MSG, { kind: 'eod_report', name: 'Acme' });
    ok(tr.calls.length === 0, 'eod_report + sender DOWN -> ZERO wire POSTs (nothing queued onto the dead sender)');
    ok(res && res.ok === false && res.skipped === true, 'eod_report + sender DOWN -> a benign skipped/dropped result (not a delivery)');
    // The attempt is still recorded on the notifications stream (visible, marked not-delivered).
    const events = await store.readEvents('notifications');
    ok(events.length === 1 && events[0].kind === 'eod_report' && events[0].ok === false, 'eod_report drop is recorded on the notifications stream as not-delivered');
  }

  // ---- (2) heartbeat + sender DOWN -> REROUTE to the fallback channel, ZERO dead-sender POSTs -
  // The heartbeat must never go silent (its absence is the alarm) but must never queue onto the
  // very sender it is often WARNING ABOUT. It reroutes the SAME body through the injected
  // out-of-band channel instead.
  {
    const tr = sendCapture();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const rerouted = [];
    const fallbackAlert = async (payload) => { rerouted.push(payload); return { ok: true, email: true }; };
    const n = new Notifier({ mode: 'whatsapp', wa, store, healthProvider: async () => false, fallbackAlert });
    const res = await n.sendDirect('+919594937777', HB_MSG, { kind: 'heartbeat', name: 'Suyashh' });
    ok(tr.calls.length === 0, 'heartbeat + sender DOWN -> ZERO wire POSTs to the dead sender');
    ok(rerouted.length === 1, 'heartbeat + sender DOWN -> the out-of-band fallback channel is invoked exactly once');
    ok(rerouted.length === 1 && rerouted[0].body === HB_MSG, 'the reroute carries the SAME rendered heartbeat body');
    ok(rerouted.length === 1 && rerouted[0].kind === 'heartbeat', 'the reroute names the message class it rerouted');
    ok(res && res.rerouted === true, 'heartbeat reroute reports rerouted:true to the caller');
  }

  // ---- (2b) heartbeat + sender DOWN + NO fallback wired -> DROP, still ZERO dead-sender POSTs --
  // Fail-SAFE degrade: a box that has not wired the reroute channel yet must still never queue
  // the heartbeat onto the dead sender - it drops (the standalone monitor covers sender-down
  // independently), it does NOT fall through to the down sender.
  {
    const tr = sendCapture();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'whatsapp', wa, store: new MemoryStore(), healthProvider: async () => false });
    const res = await n.sendDirect('+919594937777', HB_MSG, { kind: 'heartbeat', name: 'Suyashh' });
    ok(tr.calls.length === 0, 'heartbeat + DOWN + no fallback wired -> still ZERO POSTs onto the dead sender (drops, never falls through)');
    ok(res && res.ok === false, 'heartbeat + DOWN + no fallback -> not reported as delivered');
  }

  // ---- (3) positive guard: sender HEALTHY -> each class sends exactly one wire POST -----------
  // The gate must not over-block. A healthy sender sends the scheduled messages exactly as before.
  {
    const tr = sendCapture();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'whatsapp', wa, store: new MemoryStore(), healthProvider: async () => true });
    await n.sendDirect('120363000000000000@g.us', EOD_MSG, { kind: 'eod_report', name: 'Acme' });
    ok(tr.calls.length === 1, 'eod_report + sender HEALTHY -> sends exactly one wire POST');
    await n.sendDirect('+919594937777', HB_MSG, { kind: 'heartbeat', name: 'Suyashh' });
    ok(tr.calls.length === 2, 'heartbeat + sender HEALTHY -> sends exactly one wire POST (no reroute when healthy)');
  }

  // ---- (4) fail-OPEN: a probe that THROWS is treated healthy -> the send proceeds -------------
  // A monitoring blip must never cause a total scheduled-send blackout. An erroring health probe
  // fails OPEN, exactly like WhatsAppClient.sessionHealthy() does on an unreadable listPhones.
  {
    const tr = sendCapture();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const thrower = async () => { throw new Error('probe glitch'); };
    const n = new Notifier({ mode: 'whatsapp', wa, store: new MemoryStore(), healthProvider: thrower });
    const res = await n.sendDirect('+919594937777', HB_MSG, { kind: 'heartbeat', name: 'Suyashh' });
    ok(tr.calls.length === 1, 'health probe throws -> fail-OPEN -> the send proceeds (no blackout)');
    ok(res && res.ok === true, 'fail-OPEN send reports delivered');
  }

  // ---- (5) back-compat: a Notifier with NO health provider is unchanged (always sends) --------
  {
    const tr = sendCapture();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'whatsapp', wa, store: new MemoryStore() }); // no healthProvider
    await n.sendDirect('+919594937777', HB_MSG, { kind: 'heartbeat', name: 'Suyashh' });
    await n.sendDirect('120363000000000000@g.us', EOD_MSG, { kind: 'eod_report', name: 'Acme' });
    ok(tr.calls.length === 2, 'no health provider -> always-send default (existing sendDirect behaviour unchanged)');
  }

  // ---- (6) director_eod is CLASSIFIED as 'reroute' - pins the cross-PR policy decision ---------
  // The daily ~20:10 IST participation DM to the two Directors (PR #96's runDirectorEod) is a
  // named-human DM with NO catch-up: tomorrow's DM carries tomorrow's cohort, so the fail-safe
  // default 'drop' would make the day permanently missing on exactly the days the WhatsApp leg is
  // broken. These assertions fail the moment the entry is removed or downgraded to drop/retryable.
  {
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: sendCapture() });
    const n = new Notifier({ mode: 'whatsapp', wa, store: new MemoryStore(), healthProvider: async () => false });
    ok(await n._healthAction('director_eod') === 'reroute', 'director_eod + sender DOWN -> policy is REROUTE (not the fail-safe default drop)');
    ok(await n._healthAction('heartbeat') === 'reroute', 'heartbeat policy unchanged - REROUTE');
    ok(await n._healthAction('eod_report') === 'drop', 'eod_report policy unchanged - DROP (group broadcast; dashboard + tomorrow carry it)');
    ok(await n._healthAction('some_future_kind') === 'drop', 'an UNCLASSIFIED kind still fails SAFE to drop - the default is intact');
  }

  // ---- (6b) director_eod + sender DOWN -> rerouted out-of-band, ZERO dead-sender POSTs ---------
  {
    const tr = sendCapture();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const rerouted = [];
    const fallbackAlert = async (payload) => { rerouted.push(payload); return { ok: true, email: true }; };
    const n = new Notifier({ mode: 'whatsapp', wa, store, healthProvider: async () => false, fallbackAlert });
    const res = await n.sendDirect('+919594937777', DIRECTOR_MSG, { kind: 'director_eod', name: 'Suyashh' });
    ok(tr.calls.length === 0, 'director_eod + sender DOWN -> ZERO wire POSTs to the dead sender');
    ok(rerouted.length === 1 && rerouted[0].body === DIRECTOR_MSG, 'the reroute carries the SAME director DM body, verbatim');
    ok(rerouted.length === 1 && rerouted[0].kind === 'director_eod', 'the reroute names director_eod as the class it rerouted');
    // The subject must name THIS class - a Director opening a rerouted EOD must not be told it is a
    // heartbeat (the subject used to be hardcoded to the heartbeat's wording).
    ok(rerouted.length === 1 && /director_eod/.test(String(rerouted[0].subject)), 'the reroute subject names director_eod, not heartbeat');
    ok(res && res.rerouted === true, 'director_eod reroute reports rerouted:true to the caller');
  }

  // ---- (6c) director_eod + DOWN + NO fallback wired -> DROP, still ZERO dead-sender POSTs ------
  {
    const tr = sendCapture();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'whatsapp', wa, store: new MemoryStore(), healthProvider: async () => false });
    const res = await n.sendDirect('+919594937777', DIRECTOR_MSG, { kind: 'director_eod', name: 'Suyashh' });
    ok(tr.calls.length === 0, 'director_eod + DOWN + no fallback wired -> still ZERO POSTs onto the dead sender');
    ok(res && res.ok === false, 'director_eod + DOWN + no fallback -> not reported as delivered');
  }

  // ---- (6d) positive guard: director_eod + sender HEALTHY -> exactly one wire POST, no reroute --
  {
    const tr = sendCapture();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const rerouted = [];
    const fallbackAlert = async (p) => { rerouted.push(p); return { ok: true }; };
    const n = new Notifier({ mode: 'whatsapp', wa, store: new MemoryStore(), healthProvider: async () => true, fallbackAlert });
    await n.sendDirect('+919594937777', DIRECTOR_MSG, { kind: 'director_eod', name: 'Suyashh' });
    ok(tr.calls.length === 1 && rerouted.length === 0, 'director_eod + sender HEALTHY -> one normal wire POST, reroute untouched');
  }

  // ---- (7) fail-OPEN is STRICT: only a definitive `false` is "down" ---------------------------
  // A provider that returns undefined/null (a future one that forgets a return, say) is an
  // UNREADABLE probe, not a down sender. Treating it as down would fail CLOSED and blackout every
  // scheduled send - the exact outcome _healthAction's doc says must never happen.
  {
    for (const [label, provider] of [
      ['undefined', async () => {}],
      ['null', async () => null],
    ]) {
      const tr = sendCapture();
      const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
      const n = new Notifier({ mode: 'whatsapp', wa, store: new MemoryStore(), healthProvider: provider });
      const res = await n.sendDirect('+919594937777', HB_MSG, { kind: 'heartbeat', name: 'Suyashh' });
      ok(tr.calls.length === 1 && res && res.ok === true, `health probe returns ${label} -> unreadable, fail-OPEN -> the send proceeds (no blackout)`);
    }
    // ...and the definitive false still blocks, so the hardening did not disarm the breaker.
    const tr = sendCapture();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'whatsapp', wa, store: new MemoryStore(), healthProvider: async () => false });
    await n.sendDirect('120363000000000000@g.us', EOD_MSG, { kind: 'eod_report', name: 'Acme' });
    ok(tr.calls.length === 0, 'a definitive `false` still blocks - the strict check did not disarm the breaker');
  }

  // Guard the assertion count itself so a silently-dropped block cannot read as green.
  assert.strictEqual(pass + fail, 30, `expected 30 assertions, saw ${pass + fail}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
