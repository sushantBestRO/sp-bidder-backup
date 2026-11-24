'use strict';
/**
 * Send the full set of MOCK WhatsApp alert templates (one message per kind) to a phone
 * number, using the REAL Maytapi client (src/notify/whatsapp.js) - NOT a hand-rolled
 * second HTTP client. This is the manual "does a human actually receive each alert, and
 * does the copy read right on a real phone" check; the offline/mock-transport path is
 * scripts/test-whatsapp.js and the copy-only preview is scripts/create-wa-templates.js.
 *
 * SAFETY-FIRST: the default run is a DRY-RUN. It prints exactly what WOULD be sent
 * (kind + rendered text + destination) and sends NOTHING. A real send needs BOTH an
 * explicit --send flag AND a destination number:
 *
 *   node scripts/send-mock-whatsapp.js                    # DRY-RUN to the default number
 *   node scripts/send-mock-whatsapp.js 9356252711         # DRY-RUN to 9356252711
 *   node scripts/send-mock-whatsapp.js --send 9356252711  # REAL send to 9356252711
 *
 * --send with no number stays a DRY-RUN (never sends to the fallback). Before any real
 * send it fails loudly if the Maytapi creds are missing/incomplete or the configured
 * sender number is not linked/active - it never sends into a dead config. No secret
 * value is ever printed.
 */

const config = require('../src/config');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { MESSAGES, renderMessage } = require('../src/notify/waTemplates');
// Sample payload shared with create-wa-templates.js (the previewer) and
// verify-whatsapp-setup.js (the pre-deploy gate), so all three render identical copy -
// see sample-alert-data.js for why this used to be three independently hand-maintained
// (and silently drifted) copies.
const { SAMPLE } = require('./sample-alert-data');

const DEFAULT_NUMBER = '9356252711';
const SEND_DELAY_MS = 1200; // small gap so Maytapi does not rate-limit / reorder the burst

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- read-only Maytapi reachability (GET listPhones) --------------------------
// Same product-scoped endpoint + x-maytapi-key header the send client uses. Read-only:
// proves the token/productId work and that the configured sender is linked, without
// sending anything. Defensive about the response envelope and the status shape.
async function listPhones() {
  const { endpoint, productId, token } = config.whatsapp;
  if (typeof fetch !== 'function') return { ok: false, error: 'global fetch unavailable (need Node 18+)' };
  const base = String(endpoint || 'https://api.maytapi.com/api').replace(/\/$/, '');
  const url = `${base}/${productId}/listPhones`;
  let res;
  try {
    res = await fetch(url, { method: 'GET', headers: { 'x-maytapi-key': token } });
  } catch (e) { return { ok: false, error: `network: ${e && e.message}` }; }
  if (!res || !res.ok) return { ok: false, error: `http ${res ? res.status : '?'}` };
  let body = null;
  try { body = await res.json(); } catch (_) { return { ok: false, error: 'non-JSON response' }; }
  if (body && body.success === false) return { ok: false, error: (body.message || body.error) || 'maytapi success=false' };
  const phones = Array.isArray(body) ? body
    : (body && Array.isArray(body.data) ? body.data
      : (body && Array.isArray(body.phones) ? body.phones : null));
  if (!phones) return { ok: false, error: 'unexpected listPhones response shape' };
  return { ok: true, phones };
}

// Maytapi has reported phone status as a plain string ('active' | 'loading' | 'qr-screen')
// and, on newer builds, as an object. Normalize both to a lowercase status word.
function phoneStatus(entry) {
  const s = entry && entry.status;
  if (s == null) return 'unknown';
  if (typeof s === 'string') return s;
  if (typeof s === 'object') {
    if (typeof s.state === 'string') return s.state;
    if (typeof s.status === 'string') return s.status;
    if (s.loggedIn === true || s.connected === true) return 'active';
  }
  return String(s);
}

function findConfiguredPhone(phones) {
  const want = String(config.whatsapp.phoneId);
  return phones.find((p) => p && String(p.id) === want) || null;
}

(async () => {
  const args = process.argv.slice(2);
  const wantSend = args.includes('--send');
  const positional = args.filter((a) => !a.startsWith('-'));
  const numberArg = positional.length ? String(positional[0]).replace(/[^\d+]/g, '') : null;
  const dest = numberArg || DEFAULT_NUMBER;
  const doSend = wantSend && !!numberArg;

  console.log('SuperProcure bidder - mock WhatsApp alert sender (Maytapi, real client)');
  console.log('Kinds (' + MESSAGES.length + '): ' + MESSAGES.map((m) => m.kind).join(', '));
  console.log('');

  // ---- DRY-RUN (default): print what would be sent, send nothing --------------
  if (!doSend) {
    if (wantSend && !numberArg) {
      console.log('WARNING: --send given but no destination number -> staying in DRY-RUN (nothing sent).');
      console.log('         Real send needs a number: node scripts/send-mock-whatsapp.js --send ' + DEFAULT_NUMBER);
      console.log('');
    }
    console.log('MODE: DRY-RUN - no messages will be sent.');
    console.log('Destination that WOULD be used: ' + dest);
    console.log('To actually send: node scripts/send-mock-whatsapp.js --send <number>');
    console.log('');
    let i = 0;
    for (const m of MESSAGES) {
      i += 1;
      console.log('-'.repeat(64));
      console.log(`[${i}/${MESSAGES.length}] kind: ${m.kind}   ->   ${dest}   (WOULD SEND)`);
      console.log(renderMessage(m.kind, SAMPLE));
    }
    console.log('-'.repeat(64));
    console.log(`\nDRY-RUN complete: ${MESSAGES.length} messages rendered, 0 sent.`);
    process.exit(0);
  }

  // ---- LIVE SEND path --------------------------------------------------------
  console.log('MODE: LIVE SEND to ' + dest);

  const wa = new WhatsAppClient({ ...config.whatsapp, log: () => {} });

  // Preflight 1: creds present / client enabled (report missing by NAME, never value).
  if (!wa.enabled()) {
    const missing = [];
    if (config.whatsapp.enabled !== true) missing.push('SP_WHATSAPP_ENABLED (must be 1)');
    if (!config.whatsapp.token) missing.push('SP_MAYTAPI_TOKEN');
    if (!config.whatsapp.productId) missing.push('SP_MAYTAPI_PRODUCT_ID');
    if (!config.whatsapp.phoneId) missing.push('SP_MAYTAPI_PHONE_ID');
    if (typeof fetch !== 'function') missing.push('global fetch (Node 18+)');
    console.error('FATAL: WhatsApp client is not enabled - refusing to send into a dead config.');
    console.error('       Missing / not-as-expected: ' + (missing.join(', ') || 'unknown'));
    process.exit(1);
  }

  // Preflight 2: the account is reachable and the configured sender is linked/active.
  process.stdout.write('Checking Maytapi reachability (read-only listPhones)... ');
  const lp = await listPhones();
  if (!lp.ok) {
    console.error('FAIL');
    console.error('FATAL: cannot reach Maytapi / bad credentials: ' + lp.error);
    process.exit(1);
  }
  const phone = findConfiguredPhone(lp.phones);
  if (!phone) {
    console.error('FAIL');
    console.error('FATAL: configured sender (SP_MAYTAPI_PHONE_ID) is not among the ' + lp.phones.length + ' linked number(s). Not sending.');
    process.exit(1);
  }
  const st = phoneStatus(phone);
  if (String(st).toLowerCase() !== 'active') {
    console.error('FAIL');
    console.error('FATAL: configured sender is linked but not active (status: ' + st + '). Not sending.');
    process.exit(1);
  }
  console.log('OK (sender linked and active)');
  console.log('');

  // Send one message per kind, labelled for phone-side reconciliation.
  let ok = 0, fail = 0, i = 0;
  for (const m of MESSAGES) {
    i += 1;
    const text = renderMessage(m.kind, SAMPLE);
    const res = await wa.sendText(dest, text);
    if (res && res.ok) {
      ok += 1;
      console.log(`[${i}/${MESSAGES.length}] ${m.kind.padEnd(16)} -> ${dest}  DELIVERED  (messageId: ${res.messageId || 'n/a'})`);
    } else {
      fail += 1;
      console.log(`[${i}/${MESSAGES.length}] ${m.kind.padEnd(16)} -> ${dest}  FAILED     (${(res && (res.error || res.reason)) || 'unknown'})`);
    }
    if (i < MESSAGES.length) await sleep(SEND_DELAY_MS);
  }

  console.log('');
  console.log(`${ok} delivered, ${fail} failed (of ${MESSAGES.length}). Reconcile these against the phone at ${dest}.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('send-mock-whatsapp crashed:', e && e.message); process.exit(1); });
