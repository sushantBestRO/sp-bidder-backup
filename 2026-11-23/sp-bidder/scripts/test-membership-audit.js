'use strict';
/**
 * Daily membership-audit tripwire (src/notify/heartbeat.js collectMembership +
 * membershipReport, src/notify/whatsapp.js getGroups/selfNumber, src/model/staffRoster.js),
 * offline. Pins the diff logic the feature exists for: known-only -> a clean line; an unknown
 * participant -> an attention line naming the group + number; a fetch failure -> audit-unavailable;
 * an empty roster -> unconfigured (never a silent all-clear, never everyone-is-an-intruder); and the
 * bot's own number always counts as allowed. No live Maytapi: the client seam is mocked at the
 * `transport` (fetch) boundary, exactly like the existing notify tests.
 */

const {
  collectMembership, membershipReport, canonicalNumber, canonicalPhoneKey, displayNumber, renderHeartbeat, CORE_ADMINS,
} = require('../src/notify/heartbeat');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { StaffRoster } = require('../src/model/staffRoster');
const { MemoryStore } = require('../src/store');
// Sanitized capture of Maytapi's real getGroups (list) response shape - see the fixture header.
const GETGROUPS_FIXTURE = require('./fixtures/maytapi-getgroups.sample');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// Fixed reference instant (same as test-heartbeat.js): 08:00 IST on Thu 16 Jul 2026.
const NOW = Date.UTC(2026, 6, 16, 2, 30);

// The message may carry only the heartbeat's deliberate emoji set and nothing else non-ASCII; the
// membership lines must add zero non-ASCII (they are emoji-free status/issue lines).
const EMOJI = ['\u{2705}', '\u{26A0}\u{FE0F}', '\u{1F4CA}', '\u{1F4C5}', '\u{1F4C8}', '\u{1F4C9}'];
const stripEmoji = (s) => EMOJI.reduce((x, e) => x.split(e).join(''), s);
const asciiButEmoji = (s) => /^[\x20-\x7E\n]*$/.test(stripEmoji(s));

const GROUP_JID = '120363000000000001@g.us';
const GROUP = { personId: 'g1', name: 'BRL Bids - Syngenta', phone: GROUP_JID, alertPrefs: 'all', enabled: true };
// A non-group person and a disabled group must both be ignored by the audit.
const PEOPLE = [
  GROUP,
  { personId: 'p1', name: 'Suyashh Gupta', phone: '+919594937777', enabled: true },
  { personId: 'g2', name: 'BRL Bids - Old', phone: '120363000000000099@g.us', alertPrefs: 'all', enabled: false },
];

function fakePersonStore(people) { return { list: async () => people }; }
function fakeRoster(numbers) { return { list: async () => numbers }; }
function fakeWa({ groups = [], self = '919000000001', enabled = true } = {}) {
  return {
    enabled: () => enabled,
    getGroups: async () => { if (groups instanceof Error) throw groups; return groups; },
    selfNumber: async () => self,
  };
}
// One registered group, participants as @c.us JIDs. Carries neither admins nor config - the shape
// the getGroups wrapper produced before the settings tripwire, so the membership-only tests keep
// exercising exactly that, and the settings check reads it as UNVERIFIED (fail-closed).
function groupWith(participants, id = GROUP_JID, name = 'BRL Bids - Syngenta') {
  return { id, name, participants };
}

// The bot's own number (the audit's self number). It admins every group it created, so it is both
// a permitted participant and a required admin.
const BOT = '918882034647';
// {bot + the three core admins} as @c.us JIDs - the compliant admin roster for a group.
function coreAdminJids(extra = []) {
  return [BOT, ...CORE_ADMINS.map((c) => c.number)]
    .map((n) => String(n).replace(/\D/g, '') + '@c.us').concat(extra);
}
// The compliant admin roster MINUS the named core admins - the shape every "X is not admin" fixture
// below wants. Derived from CORE_ADMINS rather than spelling numbers out, because the hand-listed
// version silently broke all four of those fixtures the day a fourth core admin was added.
function coreAdminJidsWithout(...labels) {
  const drop = new Set(CORE_ADMINS.filter((c) => labels.includes(c.label)).map((c) => c.number.replace(/\D/g, '')));
  return coreAdminJids().filter((j) => !drop.has(j.split('@')[0]));
}
// A group carrying the fields the settings tripwire reads (config.membersCanAddMembers + admins[]).
// Defaults are the fully COMPLIANT state (admin-only adds; bot + all three core admins present), so
// a test spells out only the one field whose drift it exercises.
function groupFull({ participants, admins, membersCanAddMembers = false, id = GROUP_JID, name = 'BRL Bids - Syngenta' } = {}) {
  return {
    id, name,
    participants: participants || coreAdminJids(),
    admins: admins || coreAdminJids(),
    config: { edit: 'all', send: 'all', disappear: false, membersCanAddMembers, approveNewMembers: false },
  };
}
// The staff allowlist that makes coreAdminJids() participants all "known" (bot counts via self).
const CORE_ROSTER = CORE_ADMINS.map((c) => c.number);
// All-clean baseline heartbeat sections (from test-heartbeat.js), for renderer integration.
function baseSections(over = {}) {
  return Object.assign({
    accounts: { ok: true, expectedCount: 1, liveCount: 1, totalBranches: 17, branchCounts: { primary: 17 }, changes: [], tokenSoonest: null },
    sender: { ok: true, configured: true, healthy: true, mode: 'whatsapp' },
    funnel: { ok: true, discovered: 0, priced: 0, missedCutoff: 0, declined: 0, bidsPlaced: 0, loadsBid: 0, rejected: 0, won: 0, lost: 0 },
    today: { ok: true, armedToday: 0, armedLater: 0, awaiting: 0 },
  }, over);
}

(async () => {
  // ---- number canonicalization (the compare key across roster / self / participant shapes) ----
  {
    ok(canonicalNumber('+919356252711') === '9356252711', 'strips a +91 country code to the 10-digit core');
    ok(canonicalNumber('919356252711@c.us') === '9356252711', 'strips a @c.us participant JID and its country code');
    ok(canonicalNumber('9356252711') === '9356252711', 'a bare 10-digit mobile stays as its core');
    ok(canonicalNumber('09356252711') === '9356252711', 'a leading trunk 0 is removed');
    ok(canonicalNumber('0091 93562 52711') === '9356252711', 'a 0091 international prefix is removed');
    ok(canonicalNumber('') === '' && canonicalNumber(null) === '', 'empty / null reduce to empty, never throw');
    ok(displayNumber('919999999999@c.us') === '+919999999999', 'display strips the JID suffix and prefixes +');
  }

  // ---- canonicalPhoneKey: reconcile a real MSISDN id, reject an opaque @lid (the LID-migration guard) ----
  {
    ok(canonicalPhoneKey('919356252711@c.us') === '9356252711', 'a real @c.us MSISDN JID reduces to its 10-digit core');
    ok(canonicalPhoneKey('9356252711') === '9356252711', 'a bare 10-digit mobile is a reconcilable phone key');
    ok(canonicalPhoneKey('+91 93562 52711') === '9356252711', 'a formatted +91 number reconciles');
    ok(canonicalPhoneKey('199999999999999@lid') === null, 'an opaque @lid linked identifier is NOT a phone (null)');
    ok(canonicalPhoneKey('199999999999999') === null, 'a bare over-long LID-style digit string is not a phone (null)');
    ok(canonicalPhoneKey('120363000000000001@g.us') === null, 'a group JID is not an individual phone (null)');
    ok(canonicalPhoneKey('') === null && canonicalPhoneKey(null) === null, 'empty / null are not a phone (null), never throw');
  }

  // ---- WhatsAppClient.getGroups / selfNumber, mocked at the transport (fetch) seam ----
  {
    const calls = [];
    const transport = async (url, opts) => {
      calls.push({ url, key: opts && opts.headers && opts.headers['x-maytapi-key'] });
      return { ok: true, status: 200, json: async () => ({ success: true, data: [
        // participants arrive both as plain JID strings AND as { id, admin } objects across Maytapi
        // versions - both must normalize to the same bare string.
        { id: GROUP_JID, name: 'BRL Bids - Syngenta', participants: ['919000000001@c.us', { id: '919000000002@c.us', admin: true }] },
      ] }) };
    };
    const wa = new WhatsAppClient({ enabled: true, token: 'secret-tok', productId: 'p', phoneId: '1', transport });
    const gs = await wa.getGroups();
    ok(gs.length === 1 && gs[0].id === GROUP_JID && gs[0].name === 'BRL Bids - Syngenta', 'getGroups returns id + name per group');
    ok(gs[0].participants.length === 2 && gs[0].participants[0] === '919000000001@c.us' && gs[0].participants[1] === '919000000002@c.us',
      'participants normalize from both the string and the object shape');
    ok(calls[0].url === 'https://api.maytapi.com/api/p/1/getGroups', 'getGroups hits the product/phone-scoped endpoint');
    ok(calls[0].key === 'secret-tok', 'the token rides the x-maytapi-key header (and is never logged)');
  }
  {
    // getGroups now ALSO surfaces admins[] (normalized like participants) and the config block - the
    // two fields the settings tripwire reads. Older code dropped both on the floor.
    const transport = async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [
      { id: GROUP_JID, name: 'BRL Bids - Syngenta',
        participants: ['919000000001@c.us', { id: '919000000002@c.us', admin: true }],
        // admins arrive as a bare JID string AND as an { id, admin } object across versions - both normalize
        admins: ['919000000001@c.us', { id: '919000000002@c.us', admin: true }],
        config: { edit: 'all', send: 'all', disappear: false, membersCanAddMembers: false, approveNewMembers: false } },
    ] }) });
    const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '1', transport });
    const gs = await wa.getGroups();
    ok(gs[0].admins.length === 2 && gs[0].admins[0] === '919000000001@c.us' && gs[0].admins[1] === '919000000002@c.us',
      'getGroups surfaces admins[], normalized from both the string and the { id, admin } shape');
    ok(gs[0].config && gs[0].config.membersCanAddMembers === false, 'getGroups surfaces the config block incl. membersCanAddMembers');
    // a group returned with no admins/config still maps cleanly to [] admins + null config; the CALLER
    // fails that closed (this wrapper never invents a compliant-looking default).
    const bareTr = async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [{ id: GROUP_JID, name: 'g', participants: [] }] }) });
    const bare = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '1', transport: bareTr });
    const gs2 = await bare.getGroups();
    ok(Array.isArray(gs2[0].admins) && gs2[0].admins.length === 0 && gs2[0].config === null,
      'a group missing admins/config maps to [] admins + null config (the caller reads that as unverified)');
  }
  {
    const httpFail = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '1', transport: async () => ({ ok: false, status: 500 }) });
    let threw = false; try { await httpFail.getGroups(); } catch (_) { threw = true; }
    ok(threw, 'getGroups FAILS CLOSED (throws) on an HTTP error - the caller must not read it as all-clear');
    const successFalse = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '1', transport: async () => ({ ok: true, status: 200, json: async () => ({ success: false, message: 'loading' }) }) });
    let threw2 = false; try { await successFalse.getGroups(); } catch (_) { threw2 = true; }
    ok(threw2, 'getGroups throws on a 200-but-success:false body (the Maytapi loading/logged-out case)');
    const netErr = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '1', transport: async () => { throw new Error('ECONNRESET'); } });
    let threw3 = false; try { await netErr.getGroups(); } catch (_) { threw3 = true; }
    ok(threw3, 'getGroups throws on a transport (network) error');
    const off = new WhatsAppClient({ enabled: false });
    let threw4 = false; try { await off.getGroups(); } catch (_) { threw4 = true; }
    ok(threw4, 'getGroups throws when the client is disabled');
  }
  {
    const listPhones = async (url) => {
      ok(/\/p\/listPhones$/.test(url), 'selfNumber reads the product-scoped listPhones');
      return { ok: true, status: 200, json: async () => ({ success: true, data: [
        { id: '9', number: '918888888888', status: 'active' },
        { id: '7', number: '919000000001', status: 'active' },
      ] }) };
    };
    const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '7', transport: listPhones });
    ok(await wa.selfNumber() === '919000000001', 'selfNumber returns the number of the entry matching this phoneId');
    const fail = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '7', transport: async () => ({ ok: false, status: 503 }) });
    ok(await fail.selfNumber() === null, 'selfNumber returns null on a failed probe (audit then fails closed)');
    const off = new WhatsAppClient({ enabled: false });
    ok(await off.selfNumber() === null, 'selfNumber is null when the client is disabled');
  }

  // ---- collectMembership: the diff logic ----
  {
    // known-only -> clean
    const wa = fakeWa({ groups: [groupWith(['919000000001@c.us', '919000000002@c.us'])], self: '919000000001' });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(['+919000000002']) });
    ok(m.ok && m.wired && m.configured && m.fetchOk, 'known-only: the audit ran and is configured');
    ok(m.groupsChecked === 1 && m.groupsRegistered === 1, 'known-only: only the ENABLED group is registered/checked (disabled + non-group rows ignored)');
    ok(m.findings.length === 0 && m.unverifiable.length === 0, 'known-only: no findings, nothing unverifiable');
  }
  {
    // unknown present -> a finding naming the group + the number
    const wa = fakeWa({ groups: [groupWith(['919000000001@c.us', '919000000002@c.us', '919999999999@c.us'])], self: '919000000001' });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(['+919000000002']) });
    ok(m.findings.length === 1 && m.findings[0].name === 'BRL Bids - Syngenta', 'unknown: a finding names the group');
    ok(m.findings[0].unknowns.length === 1 && m.findings[0].unknowns[0] === '+919999999999', 'unknown: the finding carries the unknown number');
  }
  {
    // the bot's own number is allowed EVEN WHEN it is not on the staff roster
    const wa = fakeWa({ groups: [groupWith(['919000000001@c.us'])], self: '919000000001' });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(['+919000000002']) });
    ok(m.findings.length === 0, "the bot's own number always counts as allowed (never a self-inflicted intruder)");
  }
  {
    // roster number entered as a bare 10-digit still matches a country-coded participant JID
    const wa = fakeWa({ groups: [groupWith(['919000000001@c.us', '919000000002@c.us'])], self: '919000000001' });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(['9000000002']) });
    ok(m.findings.length === 0, 'a 10-digit roster entry matches the same number as a 91-prefixed @c.us participant');
  }
  {
    // fetch failure (getGroups throws) -> fail-closed unavailable, NOT all-clear
    const wa = fakeWa({ groups: new Error('http 500'), self: '919000000001' });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(['+919000000002']) });
    ok(m.wired && m.configured === true && m.fetchOk === false, 'fetch failure: reported unavailable (fetchOk:false), not all-clear');
    ok(!m.findings, 'fetch failure: no findings array is fabricated');
  }
  {
    // the bot's own-number lookup failing also fails the audit closed (never flag the bot)
    const wa = fakeWa({ groups: [groupWith(['919000000001@c.us'])], self: null });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(['+919000000002']) });
    ok(m.fetchOk === false, 'an unresolvable bot number fails the audit closed rather than flag the bot itself');
  }
  {
    // empty roster -> unconfigured, never "everyone is an intruder"
    const wa = fakeWa({ groups: [groupWith(['919000000001@c.us', '919999999999@c.us'])], self: '919000000001' });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster([]) });
    ok(m.wired && m.configured === false, 'empty roster: reported unconfigured');
    ok(!m.findings, 'empty roster: the present-but-unknown members are NOT flagged as intruders');
  }
  {
    // not wired into this deployment (no staffRoster dep) -> silent
    const wa = fakeWa({ groups: [groupWith(['919999999999@c.us'])], self: '919000000001' });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: null });
    ok(m.wired === false, 'no roster dep -> wired:false (renders nothing, existing heartbeat callers unaffected)');
  }
  {
    // sender off -> no fetch attempted (the heartbeat cannot send anyway)
    const wa = fakeWa({ enabled: false });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(['+919000000002']) });
    ok(m.senderOff === true, 'wa disabled -> senderOff, audit skipped cleanly');
  }
  {
    // a registered group the fetch did not return (bot removed / group deleted) -> unverifiable, not clean
    const wa = fakeWa({ groups: [], self: '919000000001' });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(['+919000000002']) });
    ok(m.unverifiable.length === 1 && m.unverifiable[0].name === 'BRL Bids - Syngenta', 'a registered group missing from the fetch is unverifiable');
    ok(m.groupsChecked === 0 && m.findings.length === 0, 'an unverifiable group is not silently counted as clean');
  }

  // ---- collectMembership: the GROUP-SETTINGS tripwire (admin-only adds + core-admin superset) ----
  {
    // fully compliant: admin-only adds, and admins == {bot + the three core admins} -> zero drift
    const wa = fakeWa({ groups: [groupFull()], self: BOT });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(CORE_ROSTER) });
    ok(m.settingsAudited === true, 'the settings audit ran (settingsAudited flag set)');
    ok(m.openAdd.length === 0 && m.adminGaps.length === 0 && m.settingsUnreadable.length === 0, 'a compliant group raises no settings drift');
    ok(m.findings.length === 0, 'and the compliant group is membership-clean too (silent, no false attention line)');
  }
  {
    // membersCanAddMembers:true -> the "anyone can add" drift, naming the group
    const wa = fakeWa({ groups: [groupFull({ membersCanAddMembers: true })], self: BOT });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(CORE_ROSTER) });
    ok(m.openAdd.length === 1 && m.openAdd[0].name === 'BRL Bids - Syngenta', 'membersCanAddMembers:true is flagged as an open-add group');
    ok(m.adminGaps.length === 0 && m.settingsUnreadable.length === 0, 'open-add alone raises only the add drift');
  }
  {
    // a core admin (Sid) demoted -> an admin gap naming him
    const admins = coreAdminJidsWithout('Sid');
    const wa = fakeWa({ groups: [groupFull({ admins })], self: BOT });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(CORE_ROSTER) });
    ok(m.adminGaps.length === 1 && m.adminGaps[0].missing.length === 1 && m.adminGaps[0].missing[0] === 'Sid', 'a core admin missing from admins[] is named in the gap');
    ok(typeof m.adminGaps[0].missing[0] === 'string', 'and is recorded as a bare label - no cause is inferred, because none can be');
    ok(m.openAdd.length === 0 && m.settingsUnreadable.length === 0, 'the admin gap does not falsely trip the add-drift or unreadable checks');
  }
  {
    // The live 2026-07-31 shape: a group provisioned WITHOUT its core admins. They are plain
    // members. That is INDISTINGUISHABLE from a demotion in a daily snapshot - demoting a WhatsApp
    // admin does not remove them from the group - so the audit records the gap and nothing else.
    const admins = coreAdminJidsWithout('Sid', 'Sushant');
    const wa = fakeWa({ groups: [groupFull({ admins })], self: BOT });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(CORE_ROSTER) });
    const labels = m.adminGaps[0].missing.slice().sort();
    ok(m.adminGaps.length === 1 && m.adminGaps[0].missing.length === 2, 'both un-promoted core admins surface on a never-provisioned group');
    ok(labels[0] === 'Sid' && labels[1] === 'Sushant', 'both are named, neither is characterised as demoted or as never-promoted');
  }
  {
    // A required admin who is not in the group AT ALL -> 'absent' (add, then promote), a different
    // remediation from a member awaiting promotion.
    const admins = [BOT, '+919594937777', '+919594963468'].map((n) => n.replace(/\D/g, '') + '@c.us');
    const participants = admins.slice(); // Sid is neither admin nor participant
    const wa = fakeWa({ groups: [groupFull({ admins, participants })], self: BOT });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(CORE_ROSTER) });
    ok(m.adminGaps.length === 1 && m.adminGaps[0].missing[0] === 'Sid', 'a core admin missing from the group entirely surfaces the same way - the gap is real either way');
  }
  {
    // An @lid participant row means absence is UNPROVEN - the missing admin might be present under
    // the opaque id. Fail closed to 'unknown' rather than assert he is not in the group.
    const admins = [BOT, '+919594937777', '+919594963468'].map((n) => n.replace(/\D/g, '') + '@c.us');
    const participants = admins.concat(['201234567890123@lid']);
    const wa = fakeWa({ groups: [groupFull({ admins, participants })], self: BOT });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(CORE_ROSTER) });
    ok(m.adminGaps[0].missing[0] === 'Sid', 'an opaque participant row changes nothing - participants are not read at all, so there is no absence claim to get wrong');
  }
  {
    // the BOT itself demoted -> the gap names the bot (the enforcement premise itself is gone)
    const admins = CORE_ADMINS.map((c) => c.number.replace(/\D/g, '') + '@c.us'); // the three humans, no bot
    const wa = fakeWa({ groups: [groupFull({ admins })], self: BOT });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(CORE_ROSTER) });
    ok(m.adminGaps.length === 1 && m.adminGaps[0].missing[0] === 'Bid Command', 'the bot losing admin is itself surfaced');
  }
  {
    // admins given as bare 10-digit cores still satisfy the +91 required set (same normalization as #48)
    const admins = [BOT, ...CORE_ADMINS.map((c) => c.number.replace(/\D/g, '').slice(-10))].map((n) => n + '@c.us');
    const wa = fakeWa({ groups: [groupFull({ admins })], self: BOT });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(CORE_ROSTER) });
    ok(m.adminGaps.length === 0, 'bare 10-digit admin JIDs reconcile with the country-coded required set');
  }
  {
    // FAIL-CLOSED: a returned group with no config/admins block cannot be verified -> settingsUnreadable, never a pass
    const wa = fakeWa({ groups: [groupWith(coreAdminJids())], self: BOT }); // groupWith carries neither config nor admins
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(CORE_ROSTER) });
    ok(m.settingsUnreadable.length === 1 && m.settingsUnreadable[0].name === 'BRL Bids - Syngenta', 'an unreadable settings block fails closed to an unverified line');
    ok(m.openAdd.length === 0 && m.adminGaps.length === 0, 'and does not fabricate an add/admin verdict it could not read');
    ok(m.findings.length === 0, 'while the membership half (readable participants) still passes cleanly');
  }
  {
    // an empty admins[] (every group has >=1 admin, so [] is a read glitch) also fails closed
    const wa = fakeWa({ groups: [groupFull({ admins: [] })], self: BOT });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(CORE_ROSTER) });
    ok(m.settingsUnreadable.length === 1 && m.adminGaps.length === 0, 'an empty admins list is unreadable (fail-closed), not "everyone was demoted"');
  }
  {
    // both drifts at once on one group -> both are surfaced independently (neither masks the other)
    const admins = [BOT, '+919594937777', '+919594963468'].map((n) => n.replace(/\D/g, '') + '@c.us'); // no Sid
    const wa = fakeWa({ groups: [groupFull({ admins, membersCanAddMembers: true })], self: BOT });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(CORE_ROSTER) });
    ok(m.openAdd.length === 1 && m.adminGaps.length === 1 && m.adminGaps[0].missing[0] === 'Sid', 'an open-add AND an admin gap on one group both surface');
  }

  // ---- SF-1: pin Maytapi's real getGroups shape (the tripwire's three assumptions) through the wrapper ----
  {
    // Feed the SANITIZED real-shape capture through the ACTUAL WhatsAppClient.getGroups() (transport
    // seam) so a wrong assumption about the provider shape fails HERE, not as a false attention DM to
    // the director on the first live heartbeat. The mock hard-coded the assumed shape; this pins it
    // against a faithful capture of what Maytapi really returns.
    const transport = async () => ({ ok: true, status: 200, json: async () => GETGROUPS_FIXTURE });
    const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '1', transport });
    const gs = await wa.getGroups();
    ok(gs.length === 2, 'the pinned response yields both groups');
    // (1) admin status is a TOP-LEVEL admins[] array - NOT an inline participants[i].admin flag
    ok(Array.isArray(gs[0].admins) && gs[0].admins.length === 4, 'admins is a top-level array per group (not an inline participant flag)');
    // (3) ids are <msisdn>@c.us JID strings - both the string and { id, admin } wire shapes normalize to that
    ok(gs[0].admins.every((a) => typeof a === 'string' && /^\d{10,15}@c\.us$/.test(a)), 'string-shape admins are bare <digits>@c.us JIDs');
    ok(gs[1].admins.length === 2 && gs[1].admins.every((a) => typeof a === 'string' && /^\d{10,15}@c\.us$/.test(a)), 'object-shape { id, admin } admins normalize to the same bare JID');
    ok(gs[0].participants.every((p) => typeof p === 'string') && gs[1].participants.every((p) => typeof p === 'string'), 'participants normalize to bare strings in both wire shapes');
    // (2) config.membersCanAddMembers is a real boolean the add-check can read
    ok(gs[0].config && typeof gs[0].config.membersCanAddMembers === 'boolean' && gs[0].config.membersCanAddMembers === false,
      'config.membersCanAddMembers is a boolean (WhatsApp who-can-add), read straight through');
  }
  {
    // The pinned real shape, end-to-end (parsed by the real wrapper -> collectMembership), must read as
    // settings-READABLE: config parsed and admins parsed as phones. This is the exact opposite of the
    // review's failure scenario (a wrong shape -> admins always [] -> every group settingsUnreadable
    // every day -> a false "attention" DM). settingsUnreadable MUST be empty here.
    const transport = async () => ({ ok: true, status: 200, json: async () => GETGROUPS_FIXTURE });
    const parsed = await new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '1', transport }).getGroups();
    const fixGroup = { personId: 'gf', name: 'Test Bids - Acme', phone: '120363000000000001@g.us', alertPrefs: 'all', enabled: true };
    const wa = fakeWa({ groups: parsed, self: '919000000001' });
    const m = await collectMembership({ wa, personStore: fakePersonStore([fixGroup]), staffRoster: fakeRoster(['919000000002', '919000000003', '919000000004', '919000000009']) });
    ok(m.settingsAudited === true && m.settingsUnreadable.length === 0, 'the parsed real shape reads as settings-READABLE (config + admins parsed), never a false unverified');
    ok(m.openAdd.length === 0, 'membersCanAddMembers:false in the real shape reads as compliant (no false open-add)');
  }
  {
    // A group in the fixture's EXACT config shape (all five real fields) with the true core-admin set
    // present must raise ZERO drift - ties the compliant path to the pinned config field name.
    const cfgShape = GETGROUPS_FIXTURE.data[0].config;   // { edit, send, disappear, membersCanAddMembers:false, approveNewMembers }
    const group = { id: GROUP_JID, name: 'BRL Bids - Syngenta', participants: coreAdminJids(), admins: coreAdminJids(), config: cfgShape };
    const wa = fakeWa({ groups: [group], self: BOT });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(CORE_ROSTER) });
    ok(m.openAdd.length === 0 && m.adminGaps.length === 0 && m.settingsUnreadable.length === 0 && m.findings.length === 0,
      "the fixture's real config shape with the core admins present raises zero drift (compliant stays silent)");
  }

  // ---- SF-1: WhatsApp-LID hardening - an un-canonicalizable admin id degrades to could-not-check, never a false demotion ----
  {
    // FULL LID migration: every admin returns as an opaque @lid. Old behavior would strip each to a long
    // non-matching digit string -> all required admins "missing" -> a false "everyone (incl. the bot)
    // was demoted". New behavior: unverifiable -> settingsUnreadable, ZERO admin gaps.
    const admins = ['199990000000001@lid', '199990000000002@lid', '199990000000003@lid', '199990000000004@lid'];
    const wa = fakeWa({ groups: [groupFull({ admins })], self: BOT });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(CORE_ROSTER) });
    ok(m.adminGaps.length === 0, 'an all-@lid admin set raises NO false "core admin demoted" gap');
    ok(m.settingsUnreadable.length === 1 && m.settingsUnreadable[0].name === 'BRL Bids - Syngenta', 'it degrades to a benign could-not-check (settingsUnreadable) instead');
  }
  {
    // The bot present as an @lid while the humans are MSISDN: an opaque id is in the set, so a "missing"
    // required admin can't be asserted -> unverified, not a false "the bot is no longer an admin".
    const admins = [`${BOT}@lid`, '919594937777@c.us', '919594963468@c.us', '919594964626@c.us'];
    const wa = fakeWa({ groups: [groupFull({ admins })], self: BOT });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(CORE_ROSTER) });
    ok(m.adminGaps.length === 0, 'the bot appearing as an @lid does not produce a false "the bot is no longer an admin"');
    ok(m.settingsUnreadable.length === 1, 'the group degrades to could-not-check while an opaque admin id is present');
  }
  {
    // Independence under LID: opaque admins (unverifiable) must NOT mask a real open-add drift on the
    // SAME group - the add-check reads config regardless of whether the admin set is readable.
    const admins = ['199990000000001@lid', '199990000000002@lid'];
    const wa = fakeWa({ groups: [groupFull({ admins, membersCanAddMembers: true })], self: BOT });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(CORE_ROSTER) });
    ok(m.openAdd.length === 1, 'a real open-add still fires even when the admin set is opaque (@lid) and unverifiable');
    ok(m.adminGaps.length === 0 && m.settingsUnreadable.length === 1, 'the opaque admins are could-not-check (no false demotion), reported independently of the add drift');
  }

  // ---- SF-2: cross-cases - one settings field UNREADABLE while the OTHER has a real drift; both surface ----
  {
    // config absent/null (unreadable add-setting) while admins[] is present with a genuinely-missing
    // core admin (Sid) -> the admin-gap line AND the config-unreadable line BOTH appear, independently.
    const admins = [BOT, '+919594937777', '+919594963468'].map((n) => n.replace(/\D/g, '') + '@c.us'); // bot, Suyashh, Sushant; no Sid
    const group = { id: GROUP_JID, name: 'BRL Bids - Syngenta', participants: coreAdminJids(), admins, config: null };
    const wa = fakeWa({ groups: [group], self: BOT });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(CORE_ROSTER) });
    ok(m.adminGaps.length === 1 && m.adminGaps[0].missing[0] === 'Sid', 'the genuinely-missing core admin surfaces as a gap even though config is unreadable');
    ok(m.settingsUnreadable.length === 1, 'and the unreadable config is reported independently (not masked by the admin gap)');
    ok(m.openAdd.length === 0, 'an unreadable add-setting is never guessed as open (fail-closed, not a false open-add)');
  }
  {
    // membersCanAddMembers:true (a real, readable open-add drift) while admins[] is unreadable (an empty
    // read-glitch) -> the open-add line AND the admins-unreadable line BOTH appear, independently.
    const wa = fakeWa({ groups: [groupFull({ admins: [], membersCanAddMembers: true })], self: BOT });
    const m = await collectMembership({ wa, personStore: fakePersonStore(PEOPLE), staffRoster: fakeRoster(CORE_ROSTER) });
    ok(m.openAdd.length === 1, 'the real open-add drift surfaces even though the admin set is unreadable');
    ok(m.settingsUnreadable.length === 1 && m.adminGaps.length === 0, 'the unreadable admins are reported (could-not-check), not masked by the add drift and never a false demotion');
  }

  // ---- membershipReport: section -> { issues, status } ----
  {
    const r = membershipReport({ ok: true, wired: true, configured: true, fetchOk: true, groupsChecked: 2, findings: [], unverifiable: [] });
    ok(r.status === '*Group membership* - all 2 customer groups staff-only' && r.issues.length === 0, 'clean -> reassuring status line, no issues');
    ok(membershipReport({ ok: true, wired: true, configured: true, fetchOk: true, groupsChecked: 1, findings: [], unverifiable: [] }).status.includes('all 1 customer group '), 'singular group phrasing');
    ok(membershipReport({ ok: true, wired: true, configured: true, fetchOk: true, groupsChecked: 0, findings: [], unverifiable: [] }).status.includes('no customer groups to check'), 'no registered groups -> a neutral, non-alarming line');
  }
  {
    const r = membershipReport({ ok: true, wired: true, configured: true, fetchOk: true, groupsChecked: 1, unverifiable: [], findings: [{ name: 'BRL Bids - Syngenta', jid: 'x', unknowns: ['+919999999999'] }] });
    ok(r.status === null && r.issues.length === 1, 'a finding produces an issue and no cheerful status line');
    ok(r.issues[0].includes('BRL Bids - Syngenta') && r.issues[0].includes('+919999999999') && r.issues[0].includes('staff-only'), 'the issue names the group, the number, and the reason');
  }
  {
    const r = membershipReport({ ok: true, wired: true, configured: true, fetchOk: true, groupsChecked: 0, unverifiable: [{ name: 'BRL Bids - Syngenta', jid: 'x' }], findings: [] });
    ok(r.issues.length === 1 && r.issues[0].includes('could not check who is in the "BRL Bids - Syngenta" group'), 'an unverifiable group is its own attention line');
  }
  {
    ok(membershipReport({ ok: true, wired: true, configured: true, fetchOk: false }).issues[0].includes('could not run'), 'fetch failure -> a could-not-run issue');
    ok(membershipReport({ ok: true, wired: true, configured: false }).issues[0].includes('not set up'), 'empty roster -> a not-set-up issue');
    ok(membershipReport({ ok: true, wired: false }).issues.length === 0 && membershipReport({ ok: true, wired: false }).status === null, 'not wired -> silent');
    ok(membershipReport({ ok: true, wired: true, senderOff: true }).issues.length === 0, 'sender off -> silent');
    ok(membershipReport(undefined).issues.length === 0, 'an absent section -> silent (existing renderHeartbeat callers unaffected)');
    ok(membershipReport({ ok: false }).issues.length === 0, 'a thrown section is left to the generic could-not-read line, not double-reported');
  }

  // ---- membershipReport: the settings verdict lines + the standing settings status ----
  {
    const clean = membershipReport({ ok: true, wired: true, configured: true, fetchOk: true, groupsChecked: 2, findings: [], unverifiable: [], settingsAudited: true, openAdd: [], adminGaps: [], settingsUnreadable: [] });
    ok(clean.issues.length === 0, 'a fully compliant audit raises no issues');
    ok(clean.status === '*Group membership* - all 2 customer groups staff-only', 'the membership standing line is unchanged');
    ok(clean.settingsStatus === '*Group settings* - all 2 locked to admin-only adds, core admins in place', 'a clean settings audit adds its own standing line');
  }
  {
    const open = membershipReport({ ok: true, wired: true, configured: true, fetchOk: true, groupsChecked: 1, findings: [], unverifiable: [], settingsAudited: true, openAdd: [{ name: 'BRL Bids - Syngenta', jid: 'x' }], adminGaps: [], settingsUnreadable: [] });
    ok(open.issues.length === 1 && open.issues[0].includes('anyone add members') && open.issues[0].includes('BRL Bids - Syngenta'), 'an open-add group is an attention line naming the group');
    ok(open.status === null && open.settingsStatus === null, 'a settings drift suppresses BOTH standing status lines');
  }
  {
    const gap = membershipReport({ ok: true, wired: true, configured: true, fetchOk: true, groupsChecked: 1, findings: [], unverifiable: [], settingsAudited: true, openAdd: [], adminGaps: [{ name: 'BRL Bids - Syngenta', jid: 'x', missing: ['Suyashh', 'Bid Command'] }], settingsUnreadable: [] });
    ok(gap.issues.length === 2, 'each missing required admin is its own line');
    ok(gap.issues.some((i) => i === 'Suyashh is not an admin of the "BRL Bids - Syngenta" group - please check and promote them'), 'the gap names the person, the group and the action, and stops there');
    // WIDENED 2026-07-31. This used to grep for the two LEGACY substrings only, which is exactly
    // how a fresh causal claim ("was never made an admin") passed green while sitting one line
    // above it. Assert the shape instead: an admin-gap line may name the person, the group and the
    // action, and must not reach for ANY tense that implies a change or a history.
    ok(gap.issues.every((i) => !/no longer|who changed this|never made|was demoted|not in the .* at all/i.test(i)),
      'no admin-gap line asserts a cause, a change or a history the snapshot cannot observe');
    ok(gap.issues.some((i) => i.endsWith('please check and promote it')) && gap.issues.some((i) => i.endsWith('please check and promote them')), 'the bot is referred to as it, the humans as them');
  }
  {
    // ONE remediation line, whatever the underlying cause. Splitting it by participant presence
    // was removed: demotion and provisioning-gap both present as a plain member, so the split
    // never separated the two things it claimed to, and it failed OPEN on an unreadable
    // participant list by rendering "not in the group at all".
    const mk = () => membershipReport({ ok: true, wired: true, configured: true, fetchOk: true, groupsChecked: 1, findings: [], unverifiable: [], settingsAudited: true, openAdd: [], adminGaps: [{ name: 'BRL Bids - Syngenta', jid: 'x', missing: ['Sid'] }], settingsUnreadable: [] });
    ok(mk().issues.length === 1, 'one gap produces exactly one line');
    ok(mk().issues[0] === 'Sid is not an admin of the "BRL Bids - Syngenta" group - please check and promote them', 'and it states the state, the group and the action - nothing about how it got that way');
  }
  {
    // backward-compat: a bare-string `missing` (a section built by an older collector mid-deploy)
    // still renders, causation-free rather than crashing or claiming a demotion.
    const legacyGap = membershipReport({ ok: true, wired: true, configured: true, fetchOk: true, groupsChecked: 1, findings: [], unverifiable: [], settingsAudited: true, openAdd: [], adminGaps: [{ name: 'BRL Bids - Syngenta', jid: 'x', missing: ['Sid'] }], settingsUnreadable: [] });
    ok(legacyGap.issues.length === 1 && legacyGap.issues[0] === 'Sid is not an admin of the "BRL Bids - Syngenta" group - please check and promote them', 'a bare-string entry renders identically - there is only one shape now');
  }
  {
    const unread = membershipReport({ ok: true, wired: true, configured: true, fetchOk: true, groupsChecked: 1, findings: [], unverifiable: [], settingsAudited: true, openAdd: [], adminGaps: [], settingsUnreadable: [{ name: 'BRL Bids - Syngenta', jid: 'x' }] });
    ok(unread.issues.length === 1 && unread.issues[0].includes('could not check the security settings') && unread.issues[0].includes('NOT verified'), 'an unreadable settings block is a fail-closed attention line');
    ok(unread.settingsStatus === null, 'and no reassuring settings line while a group is unverified');
  }
  {
    // backward-compat: a section with NO settingsAudited flag (pre-feature / hand-built) renders no settings verdict at all
    const legacy = membershipReport({ ok: true, wired: true, configured: true, fetchOk: true, groupsChecked: 2, findings: [], unverifiable: [] });
    ok(legacy.settingsStatus === null && legacy.issues.length === 0, 'a section without the settings audit adds no settings line and no settings issue');
    ok(legacy.status === '*Group membership* - all 2 customer groups staff-only', 'and the membership line is exactly as before');
  }

  // ---- renderHeartbeat integration: the four required states in a real message ----
  {
    const msg = renderHeartbeat(baseSections({ membership: { ok: true, wired: true, configured: true, fetchOk: true, groupsChecked: 3, findings: [], unverifiable: [] } }), NOW);
    ok(msg.includes('*Group membership* - all 3 customer groups staff-only'), 'clean audit renders the standing status line');
    ok(msg.startsWith('\u{2705} *Bid Command: all systems normal*'), 'a clean audit does not flip the verdict');
    ok(asciiButEmoji(msg), 'the membership status line adds no non-ASCII');
  }
  {
    const msg = renderHeartbeat(baseSections({ membership: { ok: true, wired: true, configured: true, fetchOk: true, groupsChecked: 1, unverifiable: [], findings: [{ name: 'BRL Bids - Syngenta', jid: 'x', unknowns: ['+919999999999'] }] } }), NOW);
    ok(msg.startsWith('\u{26A0}\u{FE0F} *Bid Command: attention needed*'), 'an unknown member flips the verdict to attention');
    ok(msg.includes('unknown number in the "BRL Bids - Syngenta" group: +919999999999'), 'the attention line names the group and the unknown number');
    ok(!msg.includes('*Group membership* - all'), 'no reassuring status line when there is a finding');
    ok(asciiButEmoji(msg), 'the attention line stays ASCII');
  }
  {
    const msg = renderHeartbeat(baseSections({ membership: { ok: true, wired: true, configured: true, fetchOk: false } }), NOW);
    ok(msg.startsWith('\u{26A0}\u{FE0F}'), 'an unavailable audit flips the verdict (never a silent all-clear)');
    ok(msg.includes('could not run') && msg.includes('NOT verified'), 'the message states the membership check could not run');
    ok(!msg.includes('*Group membership* - all'), 'no all-clear status line on an unavailable audit');
  }
  {
    const msg = renderHeartbeat(baseSections({ membership: { ok: true, wired: true, configured: false, groupsRegistered: 3 } }), NOW);
    ok(msg.startsWith('\u{26A0}\u{FE0F}'), 'an unconfigured roster flips the verdict');
    ok(msg.includes('not set up') && msg.includes('NOT being verified'), 'the message states the audit is not set up');
  }
  {
    const msg = renderHeartbeat(baseSections({ membership: { ok: true, wired: false } }), NOW);
    ok(!msg.includes('Group membership'), 'a not-wired audit renders nothing at all');
    ok(msg.startsWith('\u{2705}'), 'and does not disturb the verdict');
  }

  // ---- renderHeartbeat integration: the settings tripwire in a real message ----
  {
    const msg = renderHeartbeat(baseSections({ membership: { ok: true, wired: true, configured: true, fetchOk: true, groupsChecked: 3, findings: [], unverifiable: [], settingsAudited: true, openAdd: [], adminGaps: [], settingsUnreadable: [] } }), NOW);
    ok(msg.includes('*Group membership* - all 3 customer groups staff-only'), 'a clean audit still renders the membership standing line');
    ok(msg.includes('*Group settings* - all 3 locked to admin-only adds, core admins in place'), 'and the new clean settings standing line');
    ok(msg.startsWith('\u{2705} *Bid Command: all systems normal*'), 'a fully clean audit does not flip the verdict');
    ok(asciiButEmoji(msg), 'the settings status line adds no non-ASCII');
  }
  {
    const msg = renderHeartbeat(baseSections({ membership: { ok: true, wired: true, configured: true, fetchOk: true, groupsChecked: 1, findings: [], unverifiable: [], settingsAudited: true, openAdd: [{ name: 'BRL Bids - Havells', jid: 'x' }], adminGaps: [{ name: 'BRL Bids - Havells', jid: 'x', missing: ['Sid'] }], settingsUnreadable: [] } }), NOW);
    ok(msg.startsWith('\u{26A0}\u{FE0F} *Bid Command: attention needed*'), 'a settings drift flips the verdict to attention');
    ok(msg.includes('anyone add members') && msg.includes('BRL Bids - Havells'), 'the open-add drift is spelled out under the verdict');
    ok(msg.includes('Sid is not an admin of the "BRL Bids - Havells" group - please check and promote them'), 'the admin gap is spelled out and names the missing admin');
    ok(!msg.includes('*Group settings* - all'), 'no reassuring settings status line when settings drifted');
    ok(asciiButEmoji(msg), 'the settings attention lines stay ASCII');
  }
  {
    const msg = renderHeartbeat(baseSections({ membership: { ok: true, wired: true, configured: true, fetchOk: true, groupsChecked: 2, findings: [], unverifiable: [], settingsAudited: true, openAdd: [], adminGaps: [], settingsUnreadable: [{ name: 'BRL Bids - KEI', jid: 'x' }] } }), NOW);
    ok(msg.startsWith('\u{26A0}\u{FE0F}'), 'a group whose settings could not be read fails closed to attention (never a silent all-clear)');
    ok(msg.includes('could not check the security settings for the "BRL Bids - KEI" group'), 'the unreadable-settings group is named');
    ok(!msg.includes('*Group settings* - all'), 'and no all-clear settings line while a group is unverified');
  }

  // ---- StaffRoster: explicit, operator-editable, store-persisted allowlist ----
  {
    const store = new MemoryStore();
    const roster = new StaffRoster({ store });
    ok((await roster.list()).length === 0, 'a fresh roster is empty (unconfigured), never throws');
    await roster.replace(['9000000002', '+91 90000 00003', '919000000004']);
    const list = await roster.list();
    ok(list.length === 3 && list.every((n) => /^\+91[6-9]\d{9}$/.test(n)), 'replace normalizes every entry to the +91 form');
    await roster.add('9000000002');
    ok((await roster.list()).length === 3, 'add dedupes a number already on the list');
    await roster.add('9000000009');
    ok((await roster.list()).length === 4, 'add appends a new number');
    await roster.remove('9000000009');
    ok((await roster.list()).length === 3, 'remove drops a number');
    // persistence rides the store seam: a second accessor over the same store sees the same list
    ok((await new StaffRoster({ store }).list()).length === 3, 'the allowlist persists through the store seam');
    let threw = false; try { await roster.replace(['120363000000000001@g.us']); } catch (_) { threw = true; }
    ok(threw, 'a group JID is rejected from the staff allowlist (staff are individuals, never a whole group)');
    let threw2 = false; try { await roster.add('not-a-number'); } catch (_) { threw2 = true; }
    ok(threw2, 'a non-mobile is rejected (a mangled allowed-number would blind the audit)');
    ok((await roster.list()).length === 3, 'a rejected write leaves the prior list intact');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
