'use strict';
/**
 * WhatsApp GROUP addressing (Maytapi), offline. A group is reached through the same
 * sendMessage endpoint as a person - the only difference is that to_number carries the
 * group's JID ('<digits>@g.us', or the legacy '<creator>-<timestamp>@g.us') instead of a
 * phone number.
 *
 * The bug this pins: cleanNumber() used to strip every non-digit, which does not REJECT a
 * group JID - it quietly rewrites '120363042...@g.us' into '120363042...', a well-formed
 * number that Maytapi will happily deliver to whoever owns it. A silent misdelivery, not an
 * error. So the assertions below are about the JID surviving byte-for-byte to the wire, and
 * about phone numbers still normalizing exactly as they did before.
 *
 * Scope note: this file covers the CLIENT (transport) only - that a group JID reaches the wire
 * intact. The ROUTING half (a group as an alert recipient, scoped to one customer) is enabled and
 * is covered by scripts/test-group-recipients.js.
 *
 * Proven live on 2026-07-13/14 against the real account (phoneId 128023): groups created via
 * /createGroup, message delivered, success:true. Worth knowing if this is ever revisited:
 * /group/acceptInvite could NOT be made to work (every transport returns GI2 "Attr code in
 * <invite> is null"), so joining an EXISTING group is not a viable path - the bot has to CREATE
 * the group, which also leaves it as admin.
 */

const { WhatsAppClient } = require('../src/notify/whatsapp');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

function mockTransport() {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), key: opts.headers['x-maytapi-key'] });
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'mid-' + calls.length } }) };
  };
  fn.calls = calls;
  return fn;
}

const CREDS = { token: 't', productId: 'p', phoneId: '128023' };
const GROUP = '120363042212345678@g.us';        // current-format group id
const LEGACY_GROUP = '6582698370-1606900617@g.us'; // pre-2021 '<creator>-<timestamp>' form

(async () => {
  // ---- isGroupId: only a real JID counts ----
  ok(WhatsAppClient.isGroupId(GROUP), 'isGroupId accepts a current-format group JID');
  ok(WhatsAppClient.isGroupId(LEGACY_GROUP), 'isGroupId accepts the legacy <creator>-<timestamp> JID');
  ok(WhatsAppClient.isGroupId('  ' + GROUP + '  '), 'isGroupId tolerates surrounding whitespace (paste from WhatsApp)');
  ok(!WhatsAppClient.isGroupId('919000000001'), 'isGroupId rejects a plain phone number');
  ok(!WhatsAppClient.isGroupId('+91 90000 00001'), 'isGroupId rejects a formatted phone number');
  ok(!WhatsAppClient.isGroupId('919000000001@s.whatsapp.net'), 'isGroupId rejects an INDIVIDUAL jid (@s.whatsapp.net is a person, not a group)');
  ok(!WhatsAppClient.isGroupId('@g.us'), 'isGroupId rejects a bare suffix with no id');
  ok(!WhatsAppClient.isGroupId('abc@g.us'), 'isGroupId rejects a non-numeric id');
  ok(!WhatsAppClient.isGroupId(''), 'isGroupId rejects empty');
  ok(!WhatsAppClient.isGroupId(null), 'isGroupId rejects null');

  // ---- cleanNumber: the JID survives; phones normalize exactly as before ----
  ok(WhatsAppClient.cleanNumber(GROUP) === GROUP, 'cleanNumber passes a group JID through verbatim');
  ok(WhatsAppClient.cleanNumber(LEGACY_GROUP) === LEGACY_GROUP, 'cleanNumber preserves the hyphen in a legacy JID (a digit-strip would fuse the two halves)');
  ok(WhatsAppClient.cleanNumber('  ' + GROUP + '  ') === GROUP, 'cleanNumber trims a pasted JID');
  ok(WhatsAppClient.cleanNumber(GROUP.toUpperCase()) === GROUP, 'cleanNumber lowercases the JID suffix (WhatsApp ids are lowercase)');
  ok(WhatsAppClient.cleanNumber(GROUP) !== '120363042212345678', 'REGRESSION: a group JID is never reduced to a bare number (that would misdeliver, not fail)');
  ok(WhatsAppClient.cleanNumber('+91 90000 00001') === '919000000001', 'cleanNumber still strips a formatted phone to digits (unchanged)');
  ok(WhatsAppClient.cleanNumber('919000000001') === '919000000001', 'cleanNumber leaves a clean phone alone (unchanged)');
  ok(WhatsAppClient.cleanNumber('') === '', 'cleanNumber on empty stays empty (so sendText still errors on no recipient)');

  // ---- sendText: a group goes out on the same endpoint, with the JID intact in to_number ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ enabled: true, token: 'KEY123', productId: 'prod-1', phoneId: '128023', transport: tr, endpoint: 'https://api.maytapi.com/api' });
    const res = await wa.sendText(GROUP, 'Bidder group test.', { kind: 'test' });
    ok(res.ok && res.messageId === 'mid-1', 'sendText to a group returns ok + messageId');
    ok(tr.calls[0].url === 'https://api.maytapi.com/api/prod-1/128023/sendMessage', 'a group send uses the SAME sendMessage endpoint as a person');
    ok(tr.calls[0].body.to_number === GROUP, 'to_number carries the group JID intact, @g.us suffix and all');
    ok(tr.calls[0].body.type === 'text', 'a group send is still type:text');
    ok(tr.calls[0].body.message === 'Bidder group test.', 'the message body reaches a group verbatim');
    ok(tr.calls[0].key === 'KEY123', 'a group send carries the same x-maytapi-key auth');
  }

  // ---- the individual path is untouched by the group branch ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    await wa.sendText('+91 90000 00001', 'hi');
    ok(tr.calls[0].body.to_number === '919000000001', 'an individual recipient still normalizes to digits-only, no +');
  }

  // ---- the gates still apply to groups: disabled sends nothing, empty recipient errors ----
  {
    const tr = mockTransport();
    const off = new WhatsAppClient({ ...CREDS, enabled: false, transport: tr });
    const res = await off.sendText(GROUP, 'hi');
    ok(res.ok === false && res.skipped === true && tr.calls.length === 0, 'a disabled client skips a group send too (no special-casing around the enable gate)');

    const on = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const bad = await on.sendText('@g.us', 'hi');
    ok(bad.ok === false && /no recipient/.test(bad.error) && tr.calls.length === 0, 'a malformed JID degrades to "no recipient number" rather than being sent as garbage');
  }

  // ---- a group send that Maytapi rejects (not a member / bad id) is a FAILURE, not a silent ok ----
  {
    const tr = async () => ({ ok: true, status: 200, json: async () => ({ success: false, message: 'not a participant' }) });
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const res = await wa.sendText(GROUP, 'hi');
    ok(res.ok === false && /not a participant/.test(res.error), 'a 200 + success:false on a group send surfaces the error (the phone must be IN the group)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
