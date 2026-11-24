'use strict';
/**
 * Out-of-band alert channel - deliver a message through channels that do NOT ride the bidder's own
 * WhatsApp sender, so the bot can still reach a human when that sender is the very thing that has
 * failed. This is the reroute target the Notifier uses for the morning heartbeat when the sender
 * session is logged out (Notifier.sendDirect -> HEALTH_POLICY 'reroute'). Two independent tiers,
 * the same defense-in-depth the standalone monitor (scripts/monitor-wa-sender.js) pioneered during
 * the 2026-07-15 sender-logout incident:
 *
 *   - EMAIL via Brevo   -> fully independent of Maytapi/WhatsApp; the real backstop. Fires even
 *                          when ALL of WhatsApp is down. This is why the heartbeat's content (the
 *                          bot's non-sender issues: accounts down, token expiry, disk) still reaches
 *                          the reader without touching the dead sender.
 *   - SIBLING WhatsApp  -> a DIFFERENT active Maytapi phone (NEVER the down sender) posts the body
 *                          to the intended recipient; fast but Maytapi-dependent, so it is the
 *                          secondary. The healthy-sibling pick EXCLUDES the down sender BY
 *                          CONSTRUCTION (id !== senderPhoneId, status active, number present), so a
 *                          reroute can never land on the very session it is routing around.
 *
 * Why a copy of the monitor's two senders rather than importing it: the monitor is a STANDALONE
 * cron script that must run even when the whole app is dead (it imports NOTHING from src/), so the
 * app cannot depend on it and it cannot depend on the app. This module is the app-side equivalent
 * used at runtime by the Notifier. Converging the two onto this file belongs to the monitor's own
 * lane (queue-depth work, PR #77); this module deliberately does not touch monitor-wa-sender.js.
 *
 * Fail-SAFE throughout: every tier is best-effort, any error is logged and swallowed (never thrown
 * back into the send path), and a tier with no config is a silent no-op (so this ships before Brevo
 * is wired on a box - the channel simply reports ok:false and the caller's reroute degrades to a
 * DROP, which still never queues onto the dead sender). The returned promise resolves
 * { ok, email, sibling } where ok is true if ANY tier confirmed delivery.
 */
const { logAt } = require('../logging/logger');

/**
 * Build the reroute function from config. Everything network-facing is injected (`transport` is a
 * fetch-shaped function) so this is unit-testable without real HTTP.
 *
 *   maytapi : { endpoint, productId, token, senderPhoneId } - senderPhoneId is the DOWN sender to
 *             EXCLUDE from the sibling pick; the sibling send goes out from any OTHER active phone.
 *   brevo   : { apiKey, sender, to: [email], bcc: [email] } - the Maytapi-independent email tier.
 *   transport, log : injectable fetch + logger (defaults: global fetch, no-op log).
 *
 * Returns async ({ subject, body, to, name, kind }) => { ok, email, sibling }.
 */
function createFallbackAlert({ maytapi = {}, brevo = {}, transport, log = () => {} } = {}) {
  const rawSend = transport || (typeof fetch === 'function' ? fetch : null);
  const emit = (level, msg, meta) => logAt(log, level, msg, meta);

  // D007: this whole module exists to reach a human when the primary channel is down; a hung
  // socket on the reroute itself must not hang whatever awaited it. Same reference pattern as
  // realAdapter._request / whatsapp.js's _timeoutFetch.
  async function send(url, init, timeoutMs = 8000) {
    if (!rawSend) return null;
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const fullInit = ac ? Object.assign({}, init, { signal: ac.signal }) : init;
    let timer = null;
    const timeout = new Promise((_res, rej) => {
      timer = setTimeout(() => { if (ac) { try { ac.abort(); } catch (_e) {} } rej(new Error('alert_channel_timeout')); }, timeoutMs);
      if (timer && timer.unref) timer.unref();
    });
    try {
      return await Promise.race([rawSend(url, fullInit), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Review correction (26 Sep): send() only bounded the wait for HEADERS - fetch() resolves once
  // they arrive, and res.json() below was a separate, wholly unbounded await. No measured
  // send-latency figure exists in this tree, so this keeps the same 8s default.
  async function readBody(res, timeoutMs = 8000) {
    let timer = null;
    const timeout = new Promise((_res, rej) => {
      timer = setTimeout(() => rej(new Error('alert_channel_read_timeout')), timeoutMs);
      if (timer && timer.unref) timer.unref();
    });
    try {
      return await Promise.race([res.json(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // --- EMAIL via Brevo (Maytapi-independent) --------------------------------------------------
  // No API key or no recipients -> silent no-op (ships before Brevo setup). Never logs the key.
  async function emailTier(subject, text) {
    if (!rawSend || !brevo.apiKey || !Array.isArray(brevo.to) || !brevo.to.length) return false;
    const to = brevo.to.map((email) => ({ email }));
    const bcc = Array.isArray(brevo.bcc) && brevo.bcc.length ? brevo.bcc.map((email) => ({ email })) : undefined;
    const sender = { email: brevo.sender || 'alerts@bestroadways.com', name: 'BRL Bidder' };
    try {
      const payload = { sender, to, subject, textContent: text };
      if (bcc) payload.bcc = bcc;
      const res = await send('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': brevo.apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const oked = !!(res && res.ok);
      emit(oked ? 'info' : 'error', `[alertChannel] email via brevo -> ${brevo.to.length} recipient(s): http ${res ? res.status : '?'}`,
        { recipients: brevo.to.length, status: res ? res.status : null });
      return oked;
    } catch (e) { emit('error', `[alertChannel] brevo email failed: ${e && e.message}`, { err: e }); return false; }
  }

  // --- SIBLING WhatsApp (a DIFFERENT active phone, never the down sender) ----------------------
  // Reads the board (listPhones), picks an active sibling whose id !== the down sender and whose
  // number is present, and posts the body to the intended recipient FROM that sibling. Maytapi-
  // dependent, so it is best-effort and secondary to the email tier. A group JID recipient is
  // skipped (heartbeat recipients are individuals; a rerouted group message is not a case here).
  async function siblingTier(body, to) {
    const { endpoint, productId, token, senderPhoneId, fleetPhoneIds } = maytapi;
    if (!rawSend || !endpoint || !productId || !token) return false;
    const recipient = String(to == null ? '' : to).replace(/[^\d]/g, '');
    if (!recipient) return false;   // no dialable individual to reach via a sibling
    // C082: the CONFIGURED fleet (SP_MAYTAPI_FLEET_PHONE_IDS, the same list senderFleet.js draws
    // its price-ask failover candidates from), never "any active slot on the Maytapi product". An
    // unconfigured fleet (the default) has NO candidate here, matching senderFleet's own
    // "UNSET BY DEFAULT... no sibling can ever be picked" posture - this reroute must not grab an
    // unrelated number just because it happens to be active on the same account.
    const allowed = (Array.isArray(fleetPhoneIds) ? fleetPhoneIds : []).map((v) => String(v));
    if (!allowed.length) { emit('warn', '[alertChannel] no fleet phone configured for reroute (WA tier skipped)'); return false; }
    const base = String(endpoint).replace(/\/$/, '');
    const H = { 'x-maytapi-key': token };
    let phones = null;
    try {
      const res = await send(`${base}/${productId}/listPhones`, { headers: H });
      const j = res && res.ok ? await readBody(res) : null;
      phones = (j && (j.data || j)) || null;
    } catch (e) { emit('error', `[alertChannel] sibling listPhones failed: ${e && e.message}`, { err: e }); return false; }
    if (!Array.isArray(phones)) return false;
    // Pick the FIRST configured fleet phone that is active, excluding senderPhoneId - the safety
    // invariant that the reroute must never go out from the session it is routing around.
    const sibling = phones.find((p) => p && allowed.includes(String(p.id))
      && String(p.id) !== String(senderPhoneId) && p.status === 'active' && p.number != null);
    if (!sibling) { emit('warn', '[alertChannel] no active configured fleet phone to reroute from (WA tier skipped)'); return false; }
    try {
      const res = await send(`${base}/${productId}/${sibling.id}/sendMessage`, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, H),
        body: JSON.stringify({ to_number: recipient, type: 'text', message: String(body == null ? '' : body) }),
      });
      let ok = false;
      try { const j = await readBody(res); ok = !!(res && res.ok && j && j.success === true); } catch (_) { ok = false; }
      emit(ok ? 'info' : 'error', `[alertChannel] WA sibling ${sibling.id} -> recipient: success=${ok}`, { via: String(sibling.id), ok });
      return ok;
    } catch (e) { emit('error', `[alertChannel] WA sibling send failed: ${e && e.message}`, { err: e }); return false; }
  }

  return async function fallbackAlert({ subject, body, to, name, kind } = {}) {
    const subj = subject || 'BRL bidder alert';
    // Distinguish per-recipient copies (the heartbeat body is identical for all recipients, so the
    // recipient's name in the subject keeps the emails apart during an outage). Body is unchanged.
    const emailSubject = name ? `${subj} (for ${name})` : subj;
    // Both tiers run; a failure in one must not stop the other. The email tier is the real backstop,
    // so it goes first, but neither is allowed to throw (each catches internally).
    const email = await emailTier(emailSubject, body);
    const sibling = await siblingTier(body, to);
    const ok = email || sibling;
    if (!ok) emit('error', `[alertChannel] ${kind || 'alert'} reroute reached NO out-of-band channel (email + sibling both unavailable/failed)`, { kind: kind || null });
    return { ok, email, sibling };
  };
}

module.exports = { createFallbackAlert };
