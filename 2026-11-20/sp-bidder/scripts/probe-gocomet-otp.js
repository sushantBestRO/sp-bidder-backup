'use strict';
/**
 * Confirm GoComet's OTP re-auth flow against the LIVE host.
 *
 * All four legs are read off GoComet's own shipped login bundle, so this is no longer a search
 * across candidate paths - it is a CONFIRMATION that the shipped contract still holds, and the
 * fastest way to re-pin it after a GoComet redeploy. It drives src/auth/gcOtpAuth.js itself rather
 * than reimplementing the calls, so what it confirms is exactly what the bidder will do.
 *
 * It also settles the one thing the bundle could not: whether `short_lived_token` and `success`
 * arrive at the top level of the JSON or nested under `data` (the module reads both; this reports
 * which one the server actually sends).
 *
 * THIS SCRIPT IS NEVER AUTOMATIC. It is deliberately not named test-*.js, so scripts/run-tests.js
 * cannot pick it up and `npm test` stays fully offline. It refuses to do anything without an
 * explicit acknowledgement flag, and it prints no token and no credential: bodies are
 * JWT-redacted, the address is masked, the short-lived handle is never shown, and nothing is
 * written to disk.
 */

const readline = require('readline');
const gc = require('../src/auth/gcOtpAuth');

const ACK_FLAG = '--i-understand-this-sends-a-real-otp';

function parseArgs(argv) {
  const out = { ack: false, email: null, base: null, completeLogin: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === ACK_FLAG) out.ack = true;
    else if (a === '--complete-login') out.completeLogin = true;
    else if (a === '--email') { out.email = argv[i + 1] || null; i += 1; }
    else if (a === '--base') { out.base = argv[i + 1] || null; i += 1; }
  }
  return out;
}

/** Mask the address so a pasted terminal log does not carry the account's login in full. */
function maskEmail(addr) {
  const [local, domain] = String(addr).split('@');
  if (!domain) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

/** Which envelope a field arrived in - the one question the shipped bundle could not answer. */
function envelopeOf(json, key) {
  if (!json || typeof json !== 'object') return 'no JSON object';
  if (json[key] !== undefined) return `TOP-LEVEL \`${key}\``;
  if (json.data && typeof json.data === 'object' && json.data[key] !== undefined) return `nested \`data.${key}\``;
  return `\`${key}\` ABSENT`;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(String(a).trim()); }));
}

/**
 * A transport that records what came back, so the run can report the envelope shape without the
 * module having to leak it. Bodies are read once here and replayed to the module.
 */
function recordingFetch(seen) {
  return async (url, init) => {
    const r = await fetch(url, init);
    const text = await r.text().catch(() => null);
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch (_) { json = null; } }
    seen.push({ url, method: (init && init.method) || 'GET', status: r.status, json });
    return { status: r.status, text: async () => text };
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.ack || !args.email) {
    console.error([
      '',
      'REFUSING TO RUN.',
      '',
      'This talks to the LIVE GoComet auth host and WILL MAIL A REAL ONE-TIME CODE to the address',
      'you supply - a real BRL vendor account, the same one the bidder logs in as. There is no',
      'dry-run for that; the email is the evidence.',
      '',
      'By default it stops there. With --complete-login it will also ask you to type the code and',
      'then perform a REAL LOGIN, minting a real ~30-day token. Whether GoComet invalidates the',
      'existing token when a new session is created is UNVERIFIED - assume it might.',
      '',
      'Run it deliberately, with an address whose inbox you can read:',
      `  node scripts/probe-gocomet-otp.js ${ACK_FLAG} --email <address> [--complete-login]`,
      '',
      'Optional: --base <url> to point at a host other than the configured auth host.',
      '',
    ].join('\n'));
    process.exit(2);
  }

  const p = gc.authProfile({ authBaseUrl: args.base });
  console.log('');
  console.log('GoComet OTP flow confirmation - LIVE. This sends a real OTP email.');
  console.log(`  host:    ${p.base}`);
  console.log(`  address: ${maskEmail(args.email)}`);
  console.log('  legs:    1 GET  ' + p.userCheckPath);
  console.log('           2 POST ' + p.requestPath);
  console.log('           3 GET  ' + p.verifyPath);
  console.log('           4 POST ' + p.loginPath);
  console.log(`  will complete the login: ${args.completeLogin ? 'YES (mints a real token)' : 'no (stops after the email is sent)'}`);
  console.log('');

  const seen = [];
  const fetchImpl = recordingFetch(seen);

  let started;
  try {
    started = await gc.requestOtp({ email: args.email, fetchImpl, authBaseUrl: args.base });
  } catch (err) {
    console.error(`FAILED at legs 1-2: [${err.code || 'ERROR'}]`);
    console.error(gc.redactJwts(String(err.message)));
    seen.forEach((s) => console.error(`  seen: ${s.method} ${s.url} -> HTTP ${s.status}`));
    process.exit(1);
  }

  seen.forEach((s) => console.log(`  ${s.method} ${s.url.split('?')[0]} -> HTTP ${s.status}`));
  const sendCall = seen[seen.length - 1];
  console.log('');
  console.log('LEGS 1-2 CONFIRMED. A code has been emailed.');
  console.log(`  precheck (user_present): ${started.userCheck}`);
  console.log(`  envelope: ${envelopeOf(sendCall.json, 'short_lived_token')}`);
  console.log('  (the module reads both placements, so either is fine - this is just to record it)');

  if (!args.completeLogin) {
    console.log('');
    console.log('Stopping here. Re-run with --complete-login to confirm legs 3-4 as well.');
    console.log('');
    return;
  }

  const otp = await ask('\nEnter the 6-digit code from the email: ');
  const before = seen.length;
  let out;
  try {
    out = await gc.verifyOtp({ ...started, otp, fetchImpl, authBaseUrl: args.base });
  } catch (err) {
    console.error(`\nFAILED at legs 3-4: [${err.code || 'ERROR'}]`);
    console.error(gc.redactJwts(String(err.message)));
    seen.slice(before).forEach((s) => console.error(`  seen: ${s.method} ${s.url.split('?')[0]} -> HTTP ${s.status}`));
    process.exit(1);
  }

  const verifyCall = seen[before];
  seen.slice(before).forEach((s) => console.log(`  ${s.method} ${s.url.split('?')[0]} -> HTTP ${s.status}`));
  console.log('');
  console.log('LEGS 3-4 CONFIRMED. A real token was minted.');
  console.log(`  envelope: ${envelopeOf(verifyCall.json, 'success')}`);
  console.log(`  expires:  ${new Date(out.expiresAt).toISOString()}`);
  console.log(`  claims:   user_id=${(out.claims || {}).user_id || '-'} token_type=${out.tokenType || '-'}`);
  console.log(`  schemas:  ${out.schemas.length ? out.schemas.join(', ') : '(none returned)'}`);
  console.log('  the token itself is deliberately NOT printed.');

  // The mint is not the point - working on the vendor API is. Run it here so a token that logs in
  // cleanly but cannot read enquiries is caught now rather than at the next auction.
  try {
    const probe = await gc.identityProbe({ token: out.token, fetchImpl: (u, i) => fetch(u, i) });
    console.log(`\nIDENTITY PROBE OK (HTTP ${probe.status}) - this token can read the vendor API.`);
  } catch (err) {
    console.error(`\nIDENTITY PROBE FAILED: [${err.code || 'ERROR'}] ${gc.redactJwts(String(err.message))}`);
    console.error('The login worked but the token does not work where the bidder needs it.');
    process.exit(1);
  }
  console.log('');
}

if (require.main === module) {
  main().catch((err) => { console.error(gc.redactJwts(String((err && err.stack) || err))); process.exit(1); });
}

module.exports = { ACK_FLAG, maskEmail, envelopeOf, parseArgs };
