'use strict';
/**
 * Onboard an additional SuperProcure account (Phase 2: two-account auth routing).
 *
 * The only input an account needs is its token - carrierId / branchIds / the user
 * label are DERIVED by a read-only login, then validated with one read-only
 * auctions list call. This script NEVER bids, never prints the token back, and
 * never persists it: the stored record carries only the env-var NAME (tokenEnv).
 *
 * Usage (run from the app directory, same .env/data dir as the server):
 *   node scripts/add-account.js --token '<jwt>' [--token-env SP_TOKEN_2]
 *                               [--id <slug>] [--label '<name>'] [--email <addr>] [--dry-run]
 *   SP_NEW_TOKEN='<jwt>' node scripts/add-account.js            (token via env)
 *
 * --dry-run  validate + print what would be written, write nothing.
 * --mock     offline stub platform (tests/CI) - no network, canned identity.
 * --email    optional login-contact email for this branch (e.g. from the branch survey excel's
 *            "User Email ID" column) - stored in the same `accountContacts` side collection the
 *            console's manual contact editor and OTP reconnect flow use for the phone, purely
 *            for operator reference. Never an alert recipient - alerts derive only from People +
 *            Assignments. Phone isn't collected here; add it later via the console if needed.
 *
 * After a real write: add `<tokenEnv>=<the token>` to the chmod-600 .env and
 * `pm2 restart bid-command` - the boot builds one bidding stack per account.
 */

const config = require('../src/config');
const { createStore } = require('../src/store');
const { COLLECTION, validateAccount, branchOverlaps } = require('../src/auth/accounts');
const { COLLECTION: ACCOUNT_CONTACTS_COLLECTION, EMAIL_RE } = require('../src/auth/accountContacts');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--mock') out.mock = true;
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--token-env') out.tokenEnv = argv[++i];
    else if (a === '--id') out.id = argv[++i];
    else if (a === '--label') out.label = argv[++i];
    else if (a === '--email') out.email = argv[++i];
    else if (a === '--confirm-overlap') out.confirmOverlap = true;
    else out._.push(a);
  }
  return out;
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
const die = (msg) => { console.error('ERROR: ' + msg); process.exit(1); };

// Offline stub for --mock: the same read-only surface the real adapter exposes,
// with a canned identity - so the script (and its tests) run with no network.
function mockAdapter() {
  return {
    async login() {
      this.account = {
        carrierId: 2668, branchIds: [101, 102], isCarrier: 1,
        company: 'Mock Transport Co', user: 'Mock Operator',
        userId: 424242, tokenExp: Date.now() + 300 * 86_400_000,
      };
      return this.account;
    },
    async listAuctions() { return []; },
  };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const token = (args.token || process.env.SP_NEW_TOKEN || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) die('no token. Pass --token <jwt> or set SP_NEW_TOKEN. (The token is used read-only and never stored.)');
  // Trim BEFORE validating (not after) - a value pasted straight from the branch survey excel's
  // "User Email ID" column commonly carries leading/trailing whitespace, which EMAIL_RE's ^/$
  // anchors would otherwise reject outright.
  if (args.email) args.email = args.email.trim();
  if (args.email && !EMAIL_RE.test(args.email)) die(`--email '${args.email}' is not a valid email address`);

  // read-only login: derive the account identity from the token
  let adapter;
  if (args.mock) {
    adapter = mockAdapter();
  } else {
    const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
    adapter = new RealSuperProcureAdapter({ token, headers: config.capturedHeaders });
  }
  let acct;
  try { acct = await adapter.login(); }
  catch (e) { die(`login failed (${e.message}) - is the token valid and unexpired?`); }

  // read-only validation: one auctions list call proves the account can see loads
  let loads;
  try { loads = await adapter.listAuctions(); }
  catch (e) { die(`auctions list failed (${e.message}) - the token logs in but cannot list loads`); }

  const store = createStore({ dataDir: config.dataDir, logDir: require('path').join(config.dataDir, 'logs'), backend: config.storeBackend });
  const existing = await store.listDocs(COLLECTION);

  const accountId = args.id || slug(acct.company) || slug(acct.user) || `account${existing.length + 2}`;
  if (accountId === 'primary' && !args.id) die("derived id collides with 'primary' - pass an explicit --id");
  if (existing.some((d) => d && d.accountId === accountId)) {
    die(`account '${accountId}' already exists - pick a different --id (records live in the store's '${COLLECTION}' collection)`);
  }

  // pick the next free SP_TOKEN_<n> unless told otherwise; never reuse a taken name
  let tokenEnv = args.tokenEnv;
  if (!tokenEnv) {
    const taken = new Set(['SP_TOKEN', ...existing.map((d) => d && d.tokenEnv).filter(Boolean)]);
    for (let n = 2; !tokenEnv; n++) if (!taken.has(`SP_TOKEN_${n}`)) tokenEnv = `SP_TOKEN_${n}`;
  }
  if (tokenEnv !== 'SP_TOKEN' && existing.some((d) => d && d.tokenEnv === tokenEnv)) {
    die(`tokenEnv ${tokenEnv} is already used by another account - pick a different --token-env`);
  }

  let record;
  try {
    record = validateAccount({
      accountId,
      label: args.label || acct.company || acct.user || accountId,
      tokenEnv,
      enabled: true,
      carrierId: acct.carrierId,
      branchIds: acct.branchIds,
      createdAt: Date.now(),
    });
  } catch (e) { die(e.message); }

  console.log('Account validated (read-only; no bid was or can be placed):');
  console.log(`  accountId : ${record.accountId}`);
  console.log(`  label     : ${record.label}`);
  console.log(`  user      : ${acct.user || '-'} @ ${acct.company || '-'}`);
  console.log(`  carrierId : ${record.carrierId}`);
  console.log(`  branches  : ${record.branchIds.length}`);
  console.log(`  token exp : ${acct.tokenExp ? new Date(acct.tokenExp).toISOString().slice(0, 10) : 'unknown'}`);
  console.log(`  loads now : ${loads.length} visible on /sp/loads`);
  console.log(`  tokenEnv  : ${tokenEnv}  (the record stores this NAME; the token itself is never written)`);
  if (args.email) console.log(`  email     : ${args.email}  (saved to the ${ACCOUNT_CONTACTS_COLLECTION} collection, operator reference only)`);

  // PRECISE overlap check (same ground-truth branchId comparison the boot-time warning uses,
  // reused via branchOverlaps() so this and the boot log can never drift apart): does this
  // candidate share a real SuperProcure branch with an account already enabled? A wide/regional
  // login (e.g. a company-level "master" account) is EXPECTED to overlap narrower ones - the
  // shared request store still guarantees one price request per load either way - but that must
  // be a decision made HERE, at onboarding, where it's impossible to miss, not discovered later
  // in a buried pm2 log line. Always shown, dry-run or not; --confirm-overlap is required to
  // actually persist a record when the overlap is non-empty.
  const overlaps = branchOverlaps([...existing.filter((d) => d && d.enabled !== false), record])
    .filter((o) => o.a === record.accountId || o.b === record.accountId);
  if (overlaps.length) {
    console.log(`\nBranch overlap with ${overlaps.length} existing enabled account(s):`);
    for (const o of overlaps) {
      const other = o.a === record.accountId ? o.b : o.a;
      const shown = o.sharedBranchIds.slice(0, 8).join(',') + (o.sharedBranchIds.length > 8 ? ',...' : '');
      console.log(`  - '${other}': shares ${o.sharedBranchIds.length} branch id(s) (${shown})`);
    }
    console.log("  A shared branch is only ever priced by whichever account boots first (createdAt order) -");
    console.log('  fine for a deliberately wide/catch-all account layered on top of narrower ones, a real');
    console.log('  bug if two accounts were meant to be disjoint. Pass --confirm-overlap to save anyway.');
  }

  if (args.dryRun) {
    console.log('\nDRY RUN - nothing written. Re-run without --dry-run to save the account record.');
    process.exit(0);
  }

  if (overlaps.length && !args.confirmOverlap) {
    die('branch overlap with an existing enabled account (see above) - re-run with --confirm-overlap once you\'ve checked it\'s expected, or fix the branch scope first.');
  }

  // First explicit account? Materialize the until-now-implicit primary as a record
  // too - otherwise a non-empty collection would stop synthesizing it and silently
  // retire the SP_TOKEN account. Only when a live primary exists (SP_TOKEN set).
  if (existing.length === 0 && process.env.SP_TOKEN) {
    await store.putDoc(COLLECTION, 'primary', {
      accountId: 'primary', label: 'Primary', tokenEnv: 'SP_TOKEN', enabled: true, createdAt: Date.now() - 1,
    });
    console.log("\nMaterialized the existing primary account as a record too (accountId 'primary', tokenEnv SP_TOKEN).");
  }

  await store.putDoc(COLLECTION, record.accountId, record);
  console.log(`\nSaved account '${record.accountId}' to the ${COLLECTION} collection (${config.dataDir}).`);

  // Email lives in the same side collection the console's manual contact editor and OTP
  // reconnect flow use for the phone - never on the account record itself (see server.js
  // rememberAccountContact for why: it must never promote an implicit account to explicit).
  // patchDoc (merge), not putDoc (full replace): this accountId is new to the `accounts`
  // collection (checked above), but accountContacts is a SEPARATE collection with no such
  // guarantee - an orphaned contact doc (e.g. a phone recorded via a prior OTP reconnect for an
  // accountId that was later removed and reused) must not be silently wiped by this write.
  // Best-effort: the account record is already saved and announced above, so a hiccup writing
  // the (purely-cosmetic) contact email must not blow up the script or leave the operator
  // thinking the whole onboarding failed - it didn't, only the email needs a manual retry.
  if (args.email) {
    try {
      await store.patchDoc(ACCOUNT_CONTACTS_COLLECTION, record.accountId, {
        accountId: record.accountId, email: args.email.toLowerCase(), updatedAt: Date.now(),
      });
    } catch (e) {
      console.error(`\nWARNING: account saved, but the email could not be recorded (${e && e.message}). Set it later via the console's Accounts page.`);
    }
  }

  console.log('\nTo finish the connect:');
  console.log(`  1. Add to the server's .env (chmod 600, NOT committed):`);
  console.log(`         ${tokenEnv}=<paste the token here>`);
  console.log('  2. pm2 restart bid-command');
  console.log(`  3. Verify: the boot log shows "[real:${record.accountId}] logged in", and the`);
  console.log('     console Settings page lists the account as Connected.');
  process.exit(0);
})().catch((e) => { console.error('add-account failed:', e && e.stack || e); process.exit(1); });
