'use strict';
/**
 * THE SIMULATOR'S LOGGED-OUT BID REPLY CARRIES THE STATUS THE ENGINE'S AUTH CLASS READS.
 *
 * Regression target: A072. The engine classifies a refused write as AUTH on `status` 401/403 alone
 * (bidEngine isAuthRejection). The mock adapter's logged-out reply was {accepted:false, reason:'auth'}
 * with no status, so the simulator could only ever walk it down the ordinary price-refusal branch
 * and the AUTH class was unreachable in simulation. An ordinary sim refusal must stay status-less so
 * it keeps its own class.
 *
 *   node scripts/test-mock-auth-reply-status.js
 */
const { MockSuperProcureAdapter } = require('../src/platform/mockAdapter');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

(async () => {
  const sim = { submitBid: () => ({ accepted: false, reason: 'not_lower' }) };
  const a = new MockSuperProcureAdapter(sim, { latency: { base: 0, spread: 0 } });
  a.ensureSession = async () => a.session;

  a.session = { token: 't', issuedAt: 0, expiresAt: Date.now() - 1 };
  const auth = await a.placeBid('A1', 50_000);
  ok(auth.accepted === false && auth.reason === 'auth', 'a logged-out write is refused with reason auth');
  ok(auth.status === 401, `and carries status 401, the field the engine's AUTH class reads (got ${auth.status})`);

  a.session = { token: 't', issuedAt: Date.now(), expiresAt: Date.now() + 600_000 };
  const priced = await a.placeBid('A1', 50_000);
  ok(priced.accepted === false && priced.reason === 'not_lower', 'an ordinary sim refusal keeps its own reason');
  ok(priced.status !== 401 && priced.status !== 403, `and is not dressed as an auth refusal (got status ${priced.status})`);

  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
