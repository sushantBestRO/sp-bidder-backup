'use strict';
/**
 * DEEP pre-deployment verification of the WhatsApp / notification setup.
 *
 * NOT a status-code probe: it exercises the real seams and asserts on real results -
 *   1. all required Maytapi env vars present (reported by NAME only, never the value),
 *   2. LIVE Maytapi reachability via the read-only listPhones endpoint, asserting the
 *      configured sender phone is actually LINKED/active (the real proof the creds work),
 *   3. every alert template renders to non-empty text with no unfilled {{n}} placeholder,
 *   4. the notify gating is coherent - reports notifyMode + wa.enabled() so a deployer
 *      sees at a glance whether real alerts are ON or OFF and why,
 *   5. the store seam the notifier dedupes/records through is writable.
 *
 * Prints PASS/FAIL per check and a final verdict; exits non-zero on any failure. It
 * sends NO WhatsApp message (listPhones is read-only). No secret value is printed.
 *
 *   node scripts/verify-whatsapp-setup.js
 */

const path = require('path');
const config = require('../src/config');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { MESSAGES, renderMessage } = require('../src/notify/waTemplates');
const { createStore } = require('../src/store');
// Same sample payload create-wa-templates.js and send-mock-whatsapp.js use, so this
// gate exercises the real production field contract - not a locally-drifted copy that
// could report PASS on a message that actually renders every field as a blank dash.
const { SAMPLE } = require('./sample-alert-data');

let pass = 0, fail = 0, warn = 0;
function okLine(cond, name, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name + (detail ? '  - ' + detail : '')); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? '  - ' + detail : '')); }
  return !!cond;
}
function warnLine(name, detail) { warn += 1; console.log('  WARN  ' + name + (detail ? '  - ' + detail : '')); }
function info(msg) { console.log('        ' + msg); }

// ---- read-only Maytapi reachability (GET listPhones) --------------------------
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
  console.log('WhatsApp / notification pre-deploy verification');
  console.log('='.repeat(64));

  // ---- [1/5] required env vars (by NAME only) --------------------------------
  console.log('\n[1/5] Required Maytapi env vars (reported by NAME only, never the value)');
  let credsComplete = true;
  credsComplete = okLine(!!config.whatsapp.token, 'SP_MAYTAPI_TOKEN', config.whatsapp.token ? 'present' : 'ABSENT / empty') && credsComplete;
  credsComplete = okLine(!!config.whatsapp.productId, 'SP_MAYTAPI_PRODUCT_ID', config.whatsapp.productId ? 'present' : 'ABSENT / empty') && credsComplete;
  credsComplete = okLine(!!config.whatsapp.phoneId, 'SP_MAYTAPI_PHONE_ID', config.whatsapp.phoneId ? 'present' : 'ABSENT / empty') && credsComplete;
  okLine(!!config.whatsapp.endpoint, 'SP_MAYTAPI_ENDPOINT', 'set (default is api.maytapi.com/api)');
  if (config.whatsapp.enabled === true) info('SP_WHATSAPP_ENABLED is set to 1 (client may enable)');
  else warnLine('SP_WHATSAPP_ENABLED', 'not set to 1 - the WhatsApp client stays disabled (sends dark)');

  // ---- [2/5] live reachability + sender linked -------------------------------
  console.log('\n[2/5] Live Maytapi reachability (read-only listPhones; no message sent)');
  if (!credsComplete) {
    okLine(false, 'listPhones', 'skipped: credentials incomplete (see [1/5])');
  } else if (typeof fetch !== 'function') {
    okLine(false, 'listPhones', 'global fetch unavailable (need Node 18+)');
  } else {
    const lp = await listPhones();
    if (okLine(lp.ok, 'Maytapi reachable + token/productId valid', lp.ok ? (lp.phones.length + ' linked number(s) on the product') : lp.error)) {
      const phone = findConfiguredPhone(lp.phones);
      if (okLine(!!phone, 'configured sender (SP_MAYTAPI_PHONE_ID) present on the product', phone ? 'found' : 'NOT found among linked numbers')) {
        const st = phoneStatus(phone);
        const active = String(st).toLowerCase() === 'active';
        const masked = phone.number ? ', number ****' + String(phone.number).slice(-4) : '';
        okLine(active, 'configured sender is LINKED/active', 'status: ' + st + masked);
      }
    }
  }

  // ---- [3/5] every template renders cleanly ----------------------------------
  console.log('\n[3/5] Alert templates render (non-empty, no unfilled {{n}} placeholders)');
  for (const m of MESSAGES) {
    const text = renderMessage(m.kind, SAMPLE);
    const nonEmpty = typeof text === 'string' && text.trim().length > 0;
    const noPlaceholder = nonEmpty && !/\{\{\d+\}\}/.test(text);
    const detail = !nonEmpty ? 'EMPTY / null render'
      : (!noPlaceholder ? 'unfilled {{n}} placeholder remains' : (text.length + ' chars'));
    okLine(nonEmpty && noPlaceholder, 'render ' + m.kind, detail);
  }

  // ---- [4/5] notify gating coherence -----------------------------------------
  console.log('\n[4/5] Notify gating (is the WhatsApp channel ON for real events, and why)');
  const wa = new WhatsAppClient({ ...config.whatsapp, log: () => {} });
  const clientEnabled = wa.enabled();
  const modeWhatsapp = config.notifyMode === 'whatsapp';
  const wouldSend = modeWhatsapp && clientEnabled;
  info('notifyMode   = ' + config.notifyMode + (modeWhatsapp ? '' : ' (dashboard worklist only)'));
  info('wa.enabled() = ' + clientEnabled);
  info('=> real WhatsApp alerts are ' + (wouldSend ? 'ON (sends fire on live in-scope events)' : 'OFF'));
  if (modeWhatsapp && !clientEnabled) {
    okLine(false, 'gating coherent', 'notifyMode=whatsapp but client disabled - alerts silently will NOT send');
  } else {
    okLine(true, 'gating coherent', wouldSend ? 'channel ON' : 'channel intentionally OFF (notifyMode=' + config.notifyMode + ')');
    if (wouldSend) warnLine('alerts are LIVE', 'real recipients receive messages on the next in-scope event - confirm this is intended for first deploy');
    else if (clientEnabled) warnLine('alerts OFF despite a working client', 'set SP_NOTIFY_MODE=whatsapp (or the Notifications tab) to enable delivery');
  }

  // ---- [5/5] store seam writable ---------------------------------------------
  console.log('\n[5/5] Store seam writable (the dedupe/record path the notifier relies on)');
  try {
    const store = createStore({ dataDir: config.dataDir, logDir: path.join(config.dataDir, 'logs'), backend: config.storeBackend });
    const coll = '_verify_probe';
    const key = 'probe_' + process.pid + '_' + Date.now();
    await store.putDoc(coll, key, { ok: true, at: Date.now() });
    const back = await store.getDoc(coll, key);
    const roundTripped = !!(back && back.ok === true);
    await store.removeDoc(coll, key);
    okLine(roundTripped, 'keyed-doc round trip (put/get/remove)', 'backend=' + config.storeBackend + ', dataDir is writable');
    // leave nothing behind: drop the now-empty probe collection file (scripts may use fs)
    try {
      const fs = require('fs');
      const probeFile = path.join(config.dataDir, coll + '.json');
      if (fs.existsSync(probeFile)) {
        const raw = fs.readFileSync(probeFile, 'utf8').trim();
        if (raw === '{}' || raw === '') fs.unlinkSync(probeFile);
      }
    } catch (_) { /* cleanup is best-effort */ }
  } catch (e) {
    okLine(false, 'store writable', 'write failed: ' + (e && e.message));
  }

  // ---- verdict ---------------------------------------------------------------
  console.log('\n' + '='.repeat(64));
  console.log(`RESULT: ${pass} passed, ${fail} failed, ${warn} warning(s).`);
  if (fail === 0) console.log('VERDICT: READY - WhatsApp/notification setup is deployment-ready.');
  else console.log('VERDICT: NOT READY - resolve the FAIL item(s) above before deploying.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('verify-whatsapp-setup crashed:', e && e.message); process.exit(1); });
