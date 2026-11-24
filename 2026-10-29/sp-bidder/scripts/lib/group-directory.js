'use strict';

/**
 * group-directory - what a BRL bidding-desk WhatsApp group is called, which portal it serves, which
 * groups must never be touched, and how a participant row reconciles to a number. Shared by
 * provision-group.js and group-census.js; promote-fallback-admin.js should adopt it on its rebase.
 *
 * Naming standard from 2026-07-30:
 *   subject     <truck> BRL Bids <middot> SP <middot> <Customer>
 *   store name           BRL Bids <middot> SP <middot> <Customer>
 * SP | GC is the portal token. The 16 pre-existing groups carry NO token and resolve to SP
 * (portalOf), so they keep working un-renamed. A runner must scope by portalOf() or by the registered
 * JID - never by name alone, or an SP run reaches a GoComet group.
 *
 * Source stays ASCII (the separator is really U+00B7, the ornament U+1F69A) so it survives a Windows
 * shell round-trip; callers print the ornament-stripped form.
 */

const TRUCK = '\u{1F69A}';
const MIDDOT = '·';
const GROUP_NAME_PREFIX = 'BRL Bids';

const PORTAL_SP = 'SP';
const PORTAL_GC = 'GC';
const KNOWN_PORTALS = [PORTAL_SP, PORTAL_GC];

// The second controlled number. Every group gets it as member+admin at birth so none is ever
// administered by the primary sender alone - that sender has logged out three times, the last at a
// throttled 1 op/min, and while it is down nobody the system controls can administer anything. It is
// the only spare on staffRoster.json; the other four Maytapi slots are unidentified - do not use them.
const FALLBACK_NUMBER = '919594964196';
const FALLBACK_PHONE_ID = '136151';

// Excluded BY JID, never by name: the sandbox subjects miss the "BRL Bids" prefix by one character
// ('bidd' vs 'bids'), and the Alwar duplicate DOES match it - name-driven discovery sweeps in a
// retiring group. An id cannot drift.
const EXCLUDED_GROUP_JIDS = [
  { jid: '120363410291368425', reason: 'internal sandbox (BRL Bidder - group send test)' },
  { jid: '120363426916338418', reason: 'internal sandbox (BRL Bidder - group send test)' },
  { jid: '120363429139853197', reason: 'STALE DUPLICATE Havells Alwar (canonical 120363412728296902), pending retirement' },
];

// membersCanAddMembers:false is WhatsApp's "Add members -> Only admins"; these groups carry per-load
// cost/bid/margin, so add rights are the leak. edit/send stay 'all' - the desk must be able to talk.
// No `description` key, and there cannot be one: see WhatsAppClient.setGroupConfig.
const DESIRED_GROUP_CONFIG = Object.freeze({
  edit: 'all',
  send: 'all',
  disappear: false,
  membersCanAddMembers: false,
  approveNewMembers: false,
});

// group/config is a FULL REPLACE - keep whatever the group already has, force only the lock.
function mergeLockConfig(currentConfig) {
  const base = (currentConfig && typeof currentConfig === 'object') ? currentConfig : {};
  const out = Object.assign({}, DESIRED_GROUP_CONFIG, base);
  out.membersCanAddMembers = false;
  delete out.description; // echoing it back would guarantee the write fails
  return out;
}

// Live subjects start with an emoji and .trim() does not remove it, so a bare startsWith() discovers
// ZERO groups - the silent no-op that hits exactly when a runner is needed.
function stripLeadingOrnaments(name) {
  return String(name == null ? '' : name).replace(/^[^\p{L}\p{N}]+/u, '');
}

function isBrlBidsGroup(name, prefix = GROUP_NAME_PREFIX) {
  return stripLeadingOrnaments(name).toLowerCase().startsWith(String(prefix).toLowerCase());
}

// Consumed only at known positions, never used to split the whole string, so a hyphen inside a
// customer label survives.
const SEPARATOR_RUN = /^[\s·.|-]+/;

/**
 * -> { prefixOk, portal, portalExplicit, customer, raw }. Structural, not a split: require the
 * prefix, consume one separator run, then test ONLY the next token against the portal list. That is
 * what stops "BRL Bids <middot> SPML India" reading as portal SP.
 */
function parseGroupName(name) {
  const raw = String(name == null ? '' : name);
  const stripped = stripLeadingOrnaments(raw);
  if (!isBrlBidsGroup(stripped)) return { prefixOk: false, portal: null, portalExplicit: false, customer: null, raw };
  const rest = stripped.slice(GROUP_NAME_PREFIX.length).replace(SEPARATOR_RUN, '');
  const m = rest.match(/^([A-Za-z]{2,4})(?=[\s·.|-]|$)/);
  const candidate = m ? m[1].toUpperCase() : null;
  if (candidate && KNOWN_PORTALS.includes(candidate)) {
    const after = rest.slice(m[1].length).replace(SEPARATOR_RUN, '');
    return { prefixOk: true, portal: candidate, portalExplicit: true, customer: after.trim() || null, raw };
  }
  return { prefixOk: true, portal: null, portalExplicit: false, customer: rest.trim() || null, raw };
}

// No token = LEGACY-SP (every group predating the token is SuperProcure). Not a desk group -> null.
function portalOf(nameOrGroup) {
  const name = (nameOrGroup && typeof nameOrGroup === 'object') ? nameOrGroup.name : nameOrGroup;
  const parsed = parseGroupName(name);
  if (!parsed.prefixOk) return null;
  return parsed.portal || PORTAL_SP;
}

function canonicalGroupName(customerLabel, portal = PORTAL_SP) {
  const label = String(customerLabel == null ? '' : customerLabel).trim();
  const p = String(portal || PORTAL_SP).toUpperCase();
  return `${GROUP_NAME_PREFIX} ${MIDDOT} ${p} ${MIDDOT} ${label}`;
}

function waGroupSubject(customerLabel, portal = PORTAL_SP) {
  return `${TRUCK} ${canonicalGroupName(customerLabel, portal)}`;
}

// Compared on structure (prefix, token, customer), not punctuation - a '.' typed for a middle dot or
// a missing truck is not drift worth reporting. Census-only; nothing renames on this.
function nameConformsTo(liveName, customerLabel, portal = PORTAL_SP) {
  const norm = (s) => String(s == null ? '' : s)
    .replace(/[·.|-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(stripLeadingOrnaments(liveName)) === norm(canonicalGroupName(customerLabel, portal));
}

// Digit-core compare, so '<digits>@g.us' and a bare '<digits>' both match. Returns the reason so a
// caller can test and explain in one call.
function excludedReason(id, list = EXCLUDED_GROUP_JIDS) {
  const core = String(id == null ? '' : id).replace(/\D/g, '');
  if (!core) return null;
  const hit = (list || []).find((e) => String(e.jid).replace(/\D/g, '') === core);
  return hit ? hit.reason : null;
}

function isExcludedGroup(id, list = EXCLUDED_GROUP_JIDS) {
  return excludedReason(id, list) != null;
}

// Recognise-and-remove the country code, never blind-slice: slicing turns '919356252711' into a
// different, dialable number. Mirrors heartbeat.js / model/normalizePhone.js.
function canonicalNumber(raw) {
  let d = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (d.length === 14 && d.startsWith('0091')) d = d.slice(4);
  else if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

// '@lid' is the one that matters: post-LID-migration a row can be '<opaque>@lid', whose digits are
// not a dialable number, so a last-10 slice gives a confident wrong answer.
const NON_PHONE_JID = /@(?:lid|newsletter|broadcast|g\.us)$/i;

// null = opaque row, which callers degrade to could-not-check rather than a false negative.
function canonicalPhoneKey(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || NON_PHONE_JID.test(s)) return null;
  const key = canonicalNumber(s);
  return key.length >= 10 && key.length <= 13 ? key : null;
}

// 'present' | 'absent' (every row reconciled, definitive) | 'indeterminate' (an opaque row may BE
// it). Only 'absent' proves an op did not land.
function matchState(list, numberKey) {
  let opaque = false;
  for (const row of list || []) {
    const key = canonicalPhoneKey(row);
    if (key === null) { opaque = true; continue; }
    if (key === numberKey) return 'present';
  }
  return opaque ? 'indeterminate' : 'absent';
}

// true | false | null (config unreadable - not evidence of an empty description).
function hasDescription(group) {
  const cfg = group && group.config;
  if (!cfg || typeof cfg !== 'object') return null;
  const d = cfg.description;
  if (d == null) return false;
  return String(d).trim().length > 0;
}

// Print-safe form of a group name: ornaments dropped, middle dot mapped to a hyphen. Console output
// on this box is not reliably UTF-8, and a mangled group name in a report is a name an operator
// cannot match against WhatsApp.
function asciiLabel(name) {
  return stripLeadingOrnaments(name).replace(/·/g, '-').replace(/\s+/g, ' ').trim();
}

module.exports = {
  TRUCK, MIDDOT, GROUP_NAME_PREFIX,
  PORTAL_SP, PORTAL_GC, KNOWN_PORTALS,
  FALLBACK_NUMBER, FALLBACK_PHONE_ID, asciiLabel,
  EXCLUDED_GROUP_JIDS, DESIRED_GROUP_CONFIG,
  mergeLockConfig,
  stripLeadingOrnaments, isBrlBidsGroup, parseGroupName, portalOf,
  canonicalGroupName, waGroupSubject, nameConformsTo,
  excludedReason, isExcludedGroup,
  canonicalNumber, canonicalPhoneKey, matchState, hasDescription,
  NON_PHONE_JID,
};
