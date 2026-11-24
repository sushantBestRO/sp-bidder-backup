'use strict';
/**
 * Pins D007 (fix/ops-alerting-divergences).
 *
 * WhatsAppClient (src/notify/whatsapp.js) and createFallbackAlert (src/notify/alertChannel.js)
 * called their injected transport (bare fetch) with no timeout and no AbortSignal at every call
 * site. A hung socket (TCP stall, no RST) never settled, so a stuck alert send hangs whatever
 * awaited it FOREVER. Same reference pattern as realAdapter._request (test-request-timeout.js):
 * race the transport against a timer, abort() on expiry, always settle.
 *
 * Every case here uses a transport that never resolves and never rejects (worst case: it also
 * ignores the abort signal). Pre-fix, the call under test genuinely never settles, so this test
 * races each one against its OWN outer timer (independent of the fix) to fail fast rather than
 * hang the test runner - the check is "did the call settle before the outer bound", which is
 * exactly the defect.
 *
 * @requires-summary-line
 *   node scripts/test-d007-notify-transport-timeouts.js
 */
const assert = require('assert');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { createFallbackAlert } = require('../src/notify/alertChannel');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const neverSettles = () => new Promise(() => {}); // ignores the abort signal too

const TIMED_OUT = Symbol('timed_out');
function raceOuter(promise, ms) {
  return new Promise((resolve) => {
    // NOT unref'd on purpose: this guard is the only thing keeping the process alive while a
    // hung (pre-fix) promise sits forever with no timer or I/O of its own - an unref'd guard
    // timer would let Node see an empty event loop and exit before ever firing it.
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); resolve({ __rejected: true, error: e }); },
    );
  });
}

(async () => {
  // ---- WhatsAppClient._timeoutFetch, the shared helper every call site routes through ----
  {
    const wa = new WhatsAppClient({ token: 't', productId: 'p', phoneId: '1', enabled: true, transport: neverSettles });
    const t0 = Date.now();
    const result = await raceOuter(
      typeof wa._timeoutFetch === 'function' ? wa._timeoutFetch('https://example.invalid/x', {}, 150) : new Promise(() => {}),
      3000,
    );
    const dt = Date.now() - t0;
    assert.notStrictEqual(result, TIMED_OUT, `_timeoutFetch must settle on its own bound, not the outer 3s guard (took ${dt}ms)`);
    assert.ok(result && result.__rejected, '_timeoutFetch rejects on a hung transport rather than resolving with garbage');
    ok('WhatsAppClient._timeoutFetch is bounded by its own timeout, not left to hang');
  }

  // ---- getGroups (fail-closed GET path) must not hang ----
  {
    const wa = new WhatsAppClient({ token: 't', productId: 'p', phoneId: '1', enabled: true, transport: neverSettles });
    if (typeof wa._timeoutFetch === 'function') {
      const orig = wa._timeoutFetch.bind(wa);
      wa._timeoutFetch = (url, init) => orig(url, init, 150); // shorten for the test only
    }
    const result = await raceOuter(wa.getGroups().catch((e) => ({ __rejected: true, error: e })), 3000);
    assert.notStrictEqual(result, TIMED_OUT, 'getGroups must settle within its own bound, not hang the caller');
    ok('WhatsAppClient.getGroups is bounded (routes through the timeout-wrapped transport)');
  }

  // ---- sendText / _post (fail-open POST path) must resolve to a failure, never hang ----
  {
    const wa = new WhatsAppClient({ token: 't', productId: 'p', phoneId: '1', enabled: true, transport: neverSettles });
    const result = await raceOuter(wa.sendText('919000000000', 'hi'), 9000);
    assert.notStrictEqual(result, TIMED_OUT, 'sendText must settle (within the class default timeout), not hang indefinitely');
    assert.strictEqual(result && result.ok, false, 'a hung POST resolves to { ok: false }, not a hang or a thrown crash');
    ok('WhatsAppClient.sendText settles to a failure result on a hung transport');
  }

  // ---- alertChannel: the whole reroute (email + sibling tiers) must settle, never hang ----
  {
    const fallbackAlert = createFallbackAlert({
      maytapi: { endpoint: 'https://x.invalid', productId: 'p', token: 't', senderPhoneId: '1' },
      brevo: { apiKey: 'k', sender: 'a@b.com', to: ['c@d.com'] },
      transport: neverSettles,
    });
    // Two tiers run sequentially (email, then sibling), each independently bounded at ~8s by the
    // fix - so a fully hung transport can legitimately take up to ~16s to settle. The guard here is
    // slack against that, not a claim about how fast the reroute "should" be.
    const result = await raceOuter(fallbackAlert({ subject: 's', body: 'b', to: '919000000000', kind: 'test' }), 20000);
    assert.notStrictEqual(result, TIMED_OUT, 'fallbackAlert must settle (within its internal bound), not hang the reroute caller');
    assert.strictEqual(result && result.ok, false, 'a fully hung reroute reports { ok: false }, not a hang');
    ok('alertChannel fallbackAlert (email + sibling tiers) settles on a hung transport');
  }

  // ---- review correction (26 Sep): the BODY read (res.json()) must be bounded too, not only the
  // headers wait. A transport that resolves the fetch immediately (headers arrive fine) but whose
  // res.json() never settles previously hung forever - _timeoutFetch's own race had already
  // resolved by the time res.json() was awaited, so nothing was left watching it.
  {
    const wa = new WhatsAppClient({ token: 't', productId: 'p', phoneId: '1', enabled: true, transport: neverSettles });
    const result = await raceOuter(
      typeof wa._timeoutRead === 'function' ? wa._timeoutRead(neverSettles, 150) : new Promise(() => {}),
      3000,
    );
    assert.notStrictEqual(result, TIMED_OUT, '_timeoutRead must settle on its own bound, not the outer 3s guard');
    assert.ok(result && result.__rejected, '_timeoutRead rejects a stalled body read rather than hanging');
    ok('WhatsAppClient._timeoutRead bounds the body read on its own, independent of _timeoutFetch');
  }

  // ---- a real call site: headers arrive fine, the body read stalls forever ----
  {
    const stallingBodyTransport = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) });
    const wa = new WhatsAppClient({ token: 't', productId: 'p', phoneId: '1', enabled: true, transport: stallingBodyTransport });
    if (typeof wa._timeoutRead === 'function') {
      const orig = wa._timeoutRead.bind(wa);
      wa._timeoutRead = (factory) => orig(factory, 150); // shorten for the test only
    }
    const result = await raceOuter(wa.getGroups().catch((e) => ({ __rejected: true, error: e })), 3000);
    assert.notStrictEqual(result, TIMED_OUT, 'getGroups must settle even when only the BODY read stalls, not just the headers wait');
    ok('WhatsAppClient.getGroups is bounded against a stalled body read, not only a stalled connection');
  }

  // ---- alertChannel: headers arrive fine, the sibling-reroute body read stalls forever ----
  {
    const stallingBodyTransport = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) });
    const fallbackAlert = createFallbackAlert({
      maytapi: { endpoint: 'https://x.invalid', productId: 'p', token: 't', senderPhoneId: '1', fleetPhoneIds: ['1', '2'] },
      brevo: {},
      transport: stallingBodyTransport,
    });
    const result = await raceOuter(fallbackAlert({ subject: 's', body: 'b', to: '919000000000', kind: 'test' }), 20000);
    assert.notStrictEqual(result, TIMED_OUT, 'fallbackAlert must settle even when the sibling-reroute BODY read stalls forever');
    assert.strictEqual(result && result.ok, false, 'a stalled-body reroute reports { ok: false }, not a hang');
    ok('alertChannel fallbackAlert is bounded against a stalled body read on the sibling-listPhones/sendMessage calls');
  }

  console.log(`\n${pass}/7 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
