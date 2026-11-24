'use strict';

/**
 * The ONE canonical rule for how an alert recipient is addressed. Two shapes are legal:
 *
 *   a person  -> +91XXXXXXXXXX   (an Indian mobile)
 *   a group   -> <digits>@g.us   (a whole team, in one WhatsApp group)
 *
 * They are NOT interchangeable, which is why there are two entry points rather than one
 * permissive normalizer:
 *
 * - normalizePhoneIN stays STRICT (mobiles only). Some callers genuinely mean a human being -
 *   an SP account's contact person cannot be a group chat - and silently letting a group id
 *   through there would be a bug, not a feature.
 * - normalizeRecipient accepts either, and is what the ALERT-routing callers use (Person
 *   records, the legacy config.recipients rows). A Person whose phone is a group JID is how a
 *   per-customer group is modelled: assignments, scope-matching, alert-kind subscription and
 *   the notifier's dedupe-by-phone all then work unchanged.
 *
 * A group JID must never be digit-stripped. '120363...@g.us' reduces to a perfectly well-formed
 * phone number, so the alert would not fail - it would be DELIVERED, silently, to whoever owns
 * that number. That is the failure mode this module exists to make impossible.
 */

// Group ids minted since 2021 are plain digits; older ones are '<creator>-<timestamp>'.
const GROUP_JID_RE = /^\d+(-\d+)?@g\.us$/i;

function isGroupJid(raw) { return GROUP_JID_RE.test(String(raw == null ? '' : raw).trim()); }

function normalizePhoneIN(raw) {
  // Remove the country code by RECOGNISING it, never by slicing the first 10 digits off the front.
  //
  // The old rule was `.replace(/^\+91/, '').replace(/\D/g, '').slice(0, 10)`, which required a
  // literal '+' before it would strip the 91. Hand it a plain '919356252711' - the exact
  // country-coded shape Maytapi itself uses, and what anyone pastes off a WhatsApp contact - and
  // the strip does not fire: it keeps the '91' and drops the last two digits, returning
  // '+919193562527'. A DIFFERENT number. Valid, dialable, and someone else's. The caller gets a
  // 200 and the price-capture link goes to a stranger, so the failure is invisible from every
  // side. Recognise-and-remove cannot do that: anything that is not a real Indian mobile is
  // rejected outright rather than silently truncated into one.
  let d = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (d.length === 14 && d.startsWith('0091')) d = d.slice(4);   // 0091XXXXXXXXXX
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);     // 91XXXXXXXXXX (with or without '+')
  if (!/^[6-9]\d{9}$/.test(d)) { const e = new Error('needs a valid 10-digit mobile number'); e.code = 'BAD_INPUT'; throw e; }
  return `+91${d}`;
}

// An alert recipient: a person (mobile) or a group (JID). Throws BAD_INPUT on anything else.
function normalizeRecipient(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (isGroupJid(s)) return s.toLowerCase();
  // A near-miss group id ('120363...@g.us' with a typo, or an individual '...@s.whatsapp.net')
  // would otherwise fall through to the mobile rule and get digit-stripped into a plausible
  // number. Fail it loudly instead of misrouting it.
  if (s.includes('@')) { const e = new Error('not a valid WhatsApp group id (expected <digits>@g.us)'); e.code = 'BAD_INPUT'; throw e; }
  return normalizePhoneIN(s);
}

// Stable id for a recipient record: 'g' for a group, 'p' for a person, then its digits.
function recipientId(target) {
  return (isGroupJid(target) ? 'g' : 'p') + String(target).replace(/\D/g, '');
}

module.exports = { normalizePhoneIN, normalizeRecipient, isGroupJid, recipientId, GROUP_JID_RE };
