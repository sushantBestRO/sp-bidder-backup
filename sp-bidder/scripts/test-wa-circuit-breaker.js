'use strict';
/**
 * WhatsApp circuit breaker (offline). The failure it guards, seen live 2026-07-15: when the sender
 * session is logged out, Maytapi still returns 200/success:true and QUEUES the message, then floods
 * the whole stale backlog on reconnect. So `ok:true` is not delivery. Before sending an alert we
 * confirm the session is 'active'; if not, we skip the send (the request is already on the dashboard
 * worklist) rather than pile a stale message onto that queue - and we do NOT mark it sent.
 *
 * Two layers: WhatsAppClient.sessionHealthy() (cached, fail-open probe of listPhones) and the
 * Notifier's healthProvider gate (so the skip is testable without transport churn).
 */
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier } = require('../src/notify/notifier');
const { MemoryStore } = require('../src/store');
const { DiscoveryPoller } = require('../src/discovery/discovery');
const { PriceRequestStore } = require('../src/pricing/priceRequests');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const CREDS = { token: 't', productId: 'p', phoneId: '128023' };

// A transport that answers listPhones with a chosen status/number and counts how often it's hit.
function healthTransport(status, number) {
  const fn = async (url) => {
    if (/listPhones/.test(url)) { fn.listCalls += 1; return { ok: true, status: 200, json: async () => ({ data: [{ id: 128023, number, status }] }) }; }
    fn.sendCalls += 1; return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) };
  };
  fn.listCalls = 0; fn.sendCalls = 0;
  return fn;
}
function sendCapture() {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) }; };
  fn.calls = calls;
  return fn;
}

const recipients = [{ name: 'Desk', phone: '+919000000001', alerts: ['price_needed', 'won', 'lost', 'bid_live', 'outbid', 'error', 'price_submitted'] }];

(async () => {
  // ---- sessionHealthy: active is the ONLY healthy state ----
  ok(await new WhatsAppClient({ ...CREDS, enabled: true, transport: healthTransport('active', '918882034647') }).sessionHealthy() === true, 'active + number -> healthy');
  ok(await new WhatsAppClient({ ...CREDS, enabled: true, transport: healthTransport('loading', '918882034647') }).sessionHealthy() === false, 'loading -> DOWN (the transient that still cannot deliver)');
  ok(await new WhatsAppClient({ ...CREDS, enabled: true, transport: healthTransport('qr-screen', null) }).sessionHealthy() === false, 'qr-screen (logged out) -> DOWN');
  ok(await new WhatsAppClient({ ...CREDS, enabled: true, transport: healthTransport('idle', null) }).sessionHealthy() === false, 'idle -> DOWN');
  ok(await new WhatsAppClient({ ...CREDS, enabled: true, transport: healthTransport('active', null) }).sessionHealthy() === true, 'active is healthy on STATUS alone (matches the proven phoneStatus helper; number is not a health gate)');
  ok(await new WhatsAppClient({ ...CREDS, enabled: true, transport: healthTransport('ACTIVE', '9') }).sessionHealthy() === true, 'status match is case-insensitive');

  // ---- robust status parse: Maytapi has returned `status` as a string AND as an object ----
  {
    const objActive = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 128023, number: '9', status: { loggedIn: true } }] }) });
    ok(await new WhatsAppClient({ ...CREDS, enabled: true, transport: objActive }).sessionHealthy() === true, 'object-form status {loggedIn:true} -> healthy');
    const objState = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 128023, number: null, status: { state: 'loading' } }] }) });
    ok(await new WhatsAppClient({ ...CREDS, enabled: true, transport: objState }).sessionHealthy() === false, 'object-form status {state:"loading"} -> down');
    const weird = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 128023, number: '9', status: 42 }] }) });
    ok(await new WhatsAppClient({ ...CREDS, enabled: true, transport: weird }).sessionHealthy() === true, 'an unreadable status shape -> "unknown" -> fail-OPEN, never a blackout');
  }

  // ---- fail-OPEN: a probe failure must never block a real alert ----
  {
    const thrower = async () => { throw new Error('network'); };
    ok(await new WhatsAppClient({ ...CREDS, enabled: true, transport: thrower }).sessionHealthy() === true, 'listPhones throws -> fail-OPEN (assume healthy, do not block alerts)');
    const garbage = async () => ({ ok: true, status: 200, json: async () => ({ nonsense: 1 }) });
    ok(await new WhatsAppClient({ ...CREDS, enabled: true, transport: garbage }).sessionHealthy() === true, 'unreadable listPhones -> fail-OPEN');
    const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) });
    ok(await new WhatsAppClient({ ...CREDS, enabled: true, transport: http500 }).sessionHealthy() === true, 'listPhones HTTP 500 -> fail-OPEN');
  }
  ok(await new WhatsAppClient({ ...CREDS, enabled: false, transport: healthTransport('active', '9') }).sessionHealthy() === false, 'a disabled client is not "healthy" (nothing to send through)');

  // ---- cache: a burst of checks costs ONE listPhones probe, not one per check ----
  {
    const tr = healthTransport('active', '918882034647');
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr, healthTtlMs: 60000 });
    await wa.sessionHealthy(); await wa.sessionHealthy(); await wa.sessionHealthy();
    ok(tr.listCalls === 1, 'sessionHealthy caches within the TTL (3 checks -> 1 listPhones probe)');
    const tr0 = healthTransport('active', '918882034647');
    const wa0 = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr0, healthTtlMs: 0 });
    await wa0.sessionHealthy(); await wa0.sessionHealthy();
    ok(tr0.listCalls === 2, 'ttl 0 disables the cache (each check re-probes)');
  }

  // ---- notifier gate: session DOWN -> NO send, NOT marked sent (so it can fire fresh on recovery) ----
  {
    const tr = sendCapture();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store,
      recipientsProvider: async () => recipients, healthProvider: async () => false });
    const resDown = await n.requestPrice({ id: 'rqDown', loadId: 'LDown', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Acme', closesAt: 1751000000000 } });
    ok(tr.calls.length === 0, 'session DOWN -> zero WhatsApp sends (nothing queued to flood on reconnect)');
    ok(((await store.listDocs('notifSent')) || []).length === 0, 'session DOWN -> dedupe NOT marked (so it can re-fire on recovery)');
    ok(resDown && resDown.delivered === false, 'session DOWN -> requestPrice reports delivered:false (RETRYABLE - discovery re-fires while relevant)');
  }

  // ---- notifier gate: session healthy -> sends exactly as before ----
  {
    const tr = sendCapture();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
      recipientsProvider: async () => recipients, healthProvider: async () => true });
    const resUp = await n.requestPrice({ id: 'rqUp', loadId: 'LUp', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Acme', closesAt: 1751000000000 } });
    ok(tr.calls.length === 1, 'session healthy -> sends normally');
    ok(resUp && resUp.delivered === true, 'session healthy -> requestPrice reports delivered:true (done, not retried)');
  }

  // ---- no healthProvider -> unchanged behaviour (always sends; back-compat) ----
  {
    const tr = sendCapture();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
      recipientsProvider: async () => recipients }); // no healthProvider
    await n.requestPrice({ id: 'rqNP', loadId: 'LNP', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Acme', closesAt: 1751000000000 } });
    ok(tr.calls.length === 1, 'no healthProvider -> always-healthy default (existing behaviour unchanged)');
  }

  // ---- END-TO-END: discovery re-notifies on recovery (no loss on a fast recover-before-close) ----
  // This is the answer to the review's key finding: a naive skip would PERMANENTLY drop a price_needed
  // discovered during a down window. Instead the request is created (dashboard), left un-notified, and
  // re-fired the moment the session is back - IF still within its deadline.
  {
    const store = new MemoryStore();
    const requests = new PriceRequestStore({ store, marginsPct: [12, 8, 5], minMarginPct: 3 });
    const load = { id: 'L100', companyName: 'Acme', lane: { origin: 'A', destination: 'B' }, closesAt: Date.now() + 3600000, softClose: false, closeModelKnown: true, equipment: '32ft', units: 1 };
    const adapter = { listAuctions: async () => [load] };
    let healthy = false; // start DOWN
    const tr = sendCapture();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const notifier = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store,
      recipientsProvider: async () => recipients, healthProvider: async () => healthy });
    const disco = new DiscoveryPoller({ adapter, requests, notifier, config: { allowlist: { shippers: ['Acme'], hardCloseOnly: true }, priceDeadlineLeadMs: 90000 } });

    await disco.tick(); // session DOWN
    let req = await requests.getByLoad('L100');
    ok(req && req.status === 'awaiting_price', 'down tick: request still created (lands on the dashboard worklist)');
    ok(req.notified === false, 'down tick: NOT marked notified (WhatsApp push was skipped, not lost)');
    ok(tr.calls.length === 0, 'down tick: nothing sent -> nothing queued to flood on reconnect');

    healthy = true; // session RECOVERS
    await disco.tick();
    req = await requests.getByLoad('L100');
    ok(req.notified === true, 'recovery tick: re-notified + marked (the push finally goes out, not dropped)');
    ok(tr.calls.length === 1, 'recovery tick: exactly one WhatsApp push on recovery');

    const before = tr.calls.length;
    await disco.tick();
    ok(tr.calls.length === before, 'steady tick: already notified -> no duplicate send');
  }

  // ---- a STALE request (deadline passed) is NOT re-notified on recovery - dropped, never flushed ----
  {
    const store = new MemoryStore();
    const requests = new PriceRequestStore({ store, marginsPct: [12, 8, 5], minMarginPct: 3 });
    const load = { id: 'L200', companyName: 'Acme', lane: { origin: 'A', destination: 'B' }, closesAt: Date.now() + 3600000, softClose: false, closeModelKnown: true, equipment: '32ft', units: 1 };
    const adapter = { listAuctions: async () => [load] };
    let healthy = false;
    const tr = sendCapture();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const notifier = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store,
      recipientsProvider: async () => recipients, healthProvider: async () => healthy });
    const disco = new DiscoveryPoller({ adapter, requests, notifier, config: { allowlist: { shippers: ['Acme'], hardCloseOnly: true }, priceDeadlineLeadMs: 90000 } });
    await disco.tick(); // down -> created, un-notified
    // force it stale: deadline already passed
    const cur = await requests.getByLoad('L200');
    await store.patchDoc('priceRequests', cur.id, { deadlineAt: Date.now() - 1000 });
    healthy = true;
    await disco.tick(); // recovered, but the request is now stale
    const req = await requests.getByLoad('L200');
    ok(req.notified === false && tr.calls.length === 0, 'a stale (past-deadline) request is NOT re-flushed on recovery - dropped, dashboard-only');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
