'use strict';

/**
 * Accounts-as-data (Phase 2 build plan: two-account auth routing).
 *
 * An account record is operational CONFIG, persisted through the store seam:
 *   { accountId, label, tokenEnv, enabled, carrierId?, branchIds?, allowlist?, createdAt?,
 *     apiBaseUrl?, authBaseUrl?, webOrigin?, socketUrl?, socketPath?, deskCustomer? }
 *
 * The five optional URL fields carry a WHITE-LABEL tenant. SuperProcure ships the same
 * product on a customer's own host (e.g. Rallis at https://logistics.tatachemicals.com/api,
 * where an extra `/api` precedes `/sp/...`), so the tenant is a per-account fact and one
 * process can serve SP main and a white-label tenant simultaneously. All five default to
 * null, and null means "SP main" - an existing record needs no edit and behaves identically.
 * socketUrl/socketPath are separate from apiBaseUrl on purpose: socket.io reads a URL path
 * as a NAMESPACE, so the prefix cannot ride in the socket URL.
 *
 * The TOKEN ITSELF is never stored (Seam 2: secrets strictly by reference) -
 * `tokenEnv` names the environment variable that holds the bearer JWT (e.g.
 * SP_TOKEN_2 in the chmod-600 .env), resolved at boot by resolveAccountToken().
 * carrierId/branchIds are DERIVED at login (the adapter resolves them from the
 * token) and may be cached back onto the record - onboarding needs only a token.
 *
 * Zero-config default: with the accounts collection empty/absent, one implicit
 * 'primary' account reproduces today's single-account wiring exactly (SP_TOKEN,
 * the unsuffixed intents file, no label noise anywhere). Adding a 2nd account is
 * a data edit (scripts/add-account.js), zero code change.
 */

const COLLECTION = 'accounts';

const IMPLICIT_PRIMARY = Object.freeze({
  accountId: 'primary', label: 'Primary', tokenEnv: 'SP_TOKEN', enabled: true, implicit: true,
});

// accountId doubles as a filename suffix (intents.<accountId>.json) - keep it a strict
// slug so a record can never write outside the data dir. tokenEnv must be a sane env name.
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
// three dot-separated base64url segments = a JWT; the canary for "someone stored the token"
const JWT_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+$/;

const bad = (msg) => { const e = new Error(msg); e.code = 'BAD_ACCOUNT'; throw e; };

/** Validate + normalize one account record. Throws BAD_ACCOUNT on anything off. */
function validateAccount(rec) {
  if (!rec || typeof rec !== 'object') bad('account record must be an object');
  const accountId = String(rec.accountId || '').trim();
  if (!ID_RE.test(accountId)) bad(`account id '${accountId}' must match ${ID_RE} (it names the intents file)`);
  const tokenEnv = String(rec.tokenEnv || '').trim();
  if (!ENV_RE.test(tokenEnv)) bad(`account '${accountId}': tokenEnv '${tokenEnv}' must be an env-var NAME (e.g. SP_TOKEN_2)`);
  // hard wall: the record must reference a token, never contain one.
  if (rec.token) bad(`account '${accountId}' must not carry a 'token' field - store the env-var name in tokenEnv instead`);
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === 'string' && JWT_RE.test(v)) bad(`account '${accountId}': field '${k}' looks like a stored token - never persist secrets`);
  }
  // Tenant URL knob: absent -> null (the adapter's own default fires). Present -> it must be a
  // parseable absolute https URL, or we fail LOUDLY at boot. This file's whole ethos is
  // fail-closed on bad config, and a malformed base URL is uniquely nasty: it would not throw
  // at request time, it would produce a relative URL whose fetch error the adapter's retry
  // swallows into status 0 - a silently blind account that reads as "the portal is down".
  // Trailing slashes are stripped here so the record is stored canonical.
  const url = (v, field) => {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    let u;
    try { u = new URL(s); } catch (_) { return bad(`account '${accountId}': ${field} '${s}' is not a valid absolute URL`); }
    if (u.protocol !== 'https:') bad(`account '${accountId}': ${field} must be https (got '${u.protocol}')`);
    return s.replace(/\/+$/, '');
  };
  const out = {
    accountId,
    label: String(rec.label || accountId),
    tokenEnv,
    enabled: rec.enabled !== false,
    carrierId: rec.carrierId != null ? rec.carrierId : null,
    branchIds: Array.isArray(rec.branchIds) ? rec.branchIds : [],
    createdAt: rec.createdAt != null ? rec.createdAt : null,
    // --- white-label tenant knobs (absent -> null -> the adapter's SP-main defaults) ---
    // This object is rebuilt field-by-field and does NOT spread `rec`, so anything not
    // named here is silently dropped on load. A tenant field missing from this list would
    // send a tenant's token to api.superprocure.com: a live credential handed to a third
    // party, and a failure that only shows up on the newly-onboarded account.
    apiBaseUrl: url(rec.apiBaseUrl, 'apiBaseUrl'),
    authBaseUrl: url(rec.authBaseUrl, 'authBaseUrl'),
    webOrigin: url(rec.webOrigin, 'webOrigin'),
    socketUrl: url(rec.socketUrl, 'socketUrl'),
    socketPath: rec.socketPath != null ? String(rec.socketPath) : null,
    // The ONE customer this account bids for, when there is one. Read only by deskCustomerFor,
    // which routes account-wide desk notices; absent -> null -> no customer group is written to.
    deskCustomer: String(rec.deskCustomer || '').trim() || null,
  };
  if (rec.allowlist && typeof rec.allowlist === 'object') {
    const a = rec.allowlist;
    out.allowlist = {
      shippers: Array.isArray(a.shippers) ? a.shippers.map((s) => String(s).trim()).filter(Boolean) : [],
      lanes: Array.isArray(a.lanes) ? a.lanes.map((s) => String(s).trim()).filter(Boolean) : [],
      hardCloseOnly: !!a.hardCloseOnly,
    };
  }
  return out;
}

/**
 * Load every account record (validated, deterministic order: 'primary' first,
 * then createdAt, then accountId). Empty/absent collection -> the one implicit
 * primary (today's behaviour, byte-for-byte). An invalid record throws - failing
 * a boot loudly beats silently dropping a bidding account.
 */
async function loadAccounts(store) {
  const docs = await store.listDocs(COLLECTION);
  if (!docs || docs.length === 0) return [Object.assign({}, IMPLICIT_PRIMARY)];
  const accounts = docs.map(validateAccount);
  accounts.sort((a, b) => {
    if ((a.accountId === 'primary') !== (b.accountId === 'primary')) return a.accountId === 'primary' ? -1 : 1;
    if ((a.createdAt || 0) !== (b.createdAt || 0)) return (a.createdAt || 0) - (b.createdAt || 0);
    return a.accountId.localeCompare(b.accountId);
  });
  return accounts;
}

/** Resolve an account's bearer token from the env var its record names. Never logged. */
function resolveAccountToken(account, env = process.env) {
  const t = env[account.tokenEnv];
  if (t && t.trim()) return t.replace(/^Bearer\s+/i, '').trim();
  throw new Error(`no SuperProcure token for account '${account.accountId}': set ${account.tokenEnv} (chmod-600 .env in prod; export it locally for real mode)`);
}

/** The allowlist an account's discovery poller runs on: its own if set, else the global one. */
function effectiveAllowlist(account, globalAllowlist) {
  return (account && account.allowlist) || globalAllowlist || {};
}

/**
 * The ONE customer an account-wide notice about this account may be addressed to, or null.
 *
 * NULL IS THE ANSWER FOR MOST ACCOUNTS AND IS THE SAFE ONE. A shared SP-main account bids for many
 * customers, so no single customer group speaks for it and an account-wide fact about it has no
 * customer channel at all. Only a white-label tenant account - one host, one customer - does.
 *
 * Explicit `deskCustomer` wins; otherwise a shipper allowlist of EXACTLY ONE name is that customer.
 * Two or more names is not an identity, so it returns null rather than picking one. Callers must
 * treat null as "do not send", never as "send unscoped" - an empty scope key matches every unscoped
 * recipient in notifier.scopeMatches, which is a fan-out, not a no-op.
 */
function deskCustomerFor(account) {
  if (!account) return null;
  const explicit = String(account.deskCustomer || '').trim();
  if (explicit) return explicit;
  const shippers = (account.allowlist && account.allowlist.shippers) || [];
  if (shippers.length !== 1) return null;
  return String(shippers[0] || '').trim() || null;
}

// Same word-boundary token match discovery uses, so the overlap test agrees with the
// matcher it is warning about ("Syngenta" overlaps "Syngenta India", not "Warren Steel").
function tokenMatch(haystack, token) {
  const h = String(haystack).toLowerCase();
  const t = String(token).toLowerCase();
  const i = h.indexOf(t);
  if (i < 0) return false;
  return i === 0 || !/[a-z0-9]/.test(h[i - 1]);
}

/**
 * Advisory boot warning: could two enabled accounts surface the same load? They overlap when
 * their shipper scopes share a name (word-boundary match). An empty shipper list now matches
 * NOTHING (fail closed - see discovery.matchesAllowlist), so an empty-scoped account surfaces no
 * loads and cannot overlap. This only WARNS - the hard guarantee against double price requests is
 * the shared request store + the serialized discovery gate (first enabled account wins).
 */
function allowlistOverlapWarning(accounts, globalAllowlist) {
  const enabled = accounts.filter((a) => a.enabled !== false);
  if (enabled.length < 2) return null;
  for (let i = 0; i < enabled.length; i++) {
    for (let j = i + 1; j < enabled.length; j++) {
      const A = (effectiveAllowlist(enabled[i], globalAllowlist).shippers || []);
      const B = (effectiveAllowlist(enabled[j], globalAllowlist).shippers || []);
      // Fail-closed: an empty scope bids nothing, so it overlaps nothing. Both must be non-empty
      // AND share a shipper name to collide on a load.
      const overlap = A.length > 0 && B.length > 0
        && A.some((x) => B.some((y) => tokenMatch(x, y) || tokenMatch(y, x)));
      if (overlap) {
        return `accounts '${enabled[i].accountId}' and '${enabled[j].accountId}' have overlapping shipper scopes`
          + ` - a load both can see gets ONE price request, opened by the first enabled account`;
      }
    }
  }
  return null;
}

/**
 * PRECISE overlap check: do two enabled accounts share an actual SuperProcure branchId?
 * Unlike allowlistOverlapWarning (a shipper-NAME heuristic, proxying for "might see the same
 * load"), this reads the real branchIds SuperProcure granted each token at its last login -
 * ground truth, not a proxy. A shared branchId means both accounts' listAuctions() genuinely
 * CAN return the same load; the shared request store + serialized discovery gate still
 * guarantee only ONE price request gets opened (the first enabled account, deterministically -
 * `accounts` arrives pre-sorted by loadAccounts), but that account's carrierId is then the one
 * credited with the bid on every shared branch, silently, unless this is surfaced.
 *
 * Deliberately does NOT treat "both empty branchIds" as an overlap (unlike the shipper
 * heuristic's empty-list-matches-all convention) - an account with no branchIds yet just
 * hasn't completed its first login (e.g. add-account.js dry-run), not "matches everything".
 *
 * Returns one entry per overlapping PAIR, empty array when clean.
 */
function branchOverlaps(accounts) {
  const enabled = (accounts || []).filter((a) => a && a.enabled !== false);
  const out = [];
  for (let i = 0; i < enabled.length; i++) {
    const A = new Set(enabled[i].branchIds || []);
    if (!A.size) continue;
    for (let j = i + 1; j < enabled.length; j++) {
      const shared = (enabled[j].branchIds || []).filter((id) => A.has(id));
      if (shared.length) out.push({ a: enabled[i].accountId, b: enabled[j].accountId, sharedBranchIds: shared });
    }
  }
  return out;
}

/**
 * Render branchOverlaps() into boot-log-ready lines: exact shared branch ids + which account
 * wins each one (the first-listed of the pair - the real, deterministic dedupe rule discovery
 * uses). Empty array when clean, so a caller can just `.forEach(console.warn)`.
 */
function branchOverlapWarnings(accounts) {
  return branchOverlaps(accounts).map(({ a, b, sharedBranchIds }) => {
    const shown = sharedBranchIds.slice(0, 8).join(',') + (sharedBranchIds.length > 8 ? ',...' : '');
    return `accounts '${a}' and '${b}' share ${sharedBranchIds.length} real SuperProcure branch id(s) `
      + `(${shown}) - a load on those branches is only ever priced by '${a}' (first enabled); `
      + `if '${b}' should own them instead, fix the branchIds on SuperProcure's side or reorder createdAt`;
  });
}

/**
 * D013: reconnect/verify refuses a token on a carrierId mismatch (a genuinely different SuperProcure
 * account), but a DIFFERENT USER on the SAME carrier (a role change, a shared login, someone else's
 * phone) is unusual, not wrong - it must warn ops, never refuse the desk a working reconnect. Returns
 * the alert detail string, or null when there is nothing to warn about (either side unknown, or the
 * two match).
 *
 * Compares knownUserId/identUserId when the caller has them (review correction, 26 Sep) - the
 * DISPLAY name (knownUser/identUser) is mutable (a profile rename) and not even unique (a generic
 * or shared login label), so comparing it directly either false-alarms on an ordinary rename or
 * misses a genuine identity change hiding behind an identical label. knownUser/identUser still
 * decide what the message SHOWS a human, and the function falls back to comparing them directly
 * when no id is supplied, so an existing caller with only display names is unchanged.
 */
function reconnectUserWarning({ label, knownUser, identUser, knownUserId, identUserId }) {
  const knownKey = knownUserId != null ? knownUserId : knownUser;
  const identKey = identUserId != null ? identUserId : identUser;
  if (knownKey == null || identKey == null) return null;
  if (String(knownKey) === String(identKey)) return null;
  const knownLabel = knownUser != null ? knownUser : knownKey;
  const identLabel = identUser != null ? identUser : identKey;
  return `${label} was reconnected by a different SuperProcure user (was '${knownLabel}', now '${identLabel}') - confirm this was expected.`;
}

module.exports = {
  COLLECTION, IMPLICIT_PRIMARY,
  validateAccount, loadAccounts, resolveAccountToken,
  effectiveAllowlist, allowlistOverlapWarning, deskCustomerFor,
  branchOverlaps, branchOverlapWarnings, reconnectUserWarning,
};
