'use strict';
/**
 * A RETRIED LOGIN MUST READ THE SERVER CLOCK AGAINST THE ATTEMPT THAT ANSWERED.
 *
 * getAvailableViews `currentTime` (whole Unix seconds) is stamped inside the round trip of the request
 * that got the answer. login() goes through _get, which retries a 429/503 or a dropped connection
 * after a backoff. Timing the whole call - first send to final receipt - puts the "middle of the
 * round trip" inside the backoff, seconds from where the server actually stamped the reply, and
 * reading it against the final receipt alone adds the whole return leg. Either way the REST clock
 * (listing status and the countdown when no socket is attached) is off by far more than the half
 * second a whole-second reading cannot resolve.
 *
 * Offline and deterministic: the real adapter's real login() on a fake local clock, a transport stub
 * that answers 503 once and then succeeds, no network.
 *
 *   node scripts/test-sp-clock-rest-retry.js
 */
const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

const EXPECTED = 1;
let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
process.on('exit', (code) => {
  if (code === 0 && pass !== EXPECTED) {
    console.error(`COMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED}`);
    process.exitCode = 1;
  }
});

const THETA = 2_345, UP = 20, DOWN = 20, BACKOFF = 2_000;
const PHASES = [0, 250, 500, 750, 950];

(async () => {
  const errs = [];
  for (const phase of PHASES) {
    let clock = 1_789_990_000_000;
    Date.now = () => clock;
    let calls = 0;
    const fetchImpl = async (url) => {
      calls++;
      clock += UP;
      const stamp = clock + THETA;
      clock += DOWN;
      if (calls === 1) return { status: 503, headers: { get: () => null }, text: async () => 'busy' };
      const body = { data: { currentTime: Math.floor(stamp / 1000), isCarrier: true,
        userInfo: { name: 'Test User', companyName: 'Best Roadways' },
        carrierBranches: [2667], branchList: { 956055: { branchId: 956055 } } } };
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    };
    const sleep = async (ms) => { clock += BACKOFF; };
    const a = new RealSuperProcureAdapter({ token: 'x', fetchImpl, sleep, rand: () => 0.5 });
    // The answered attempt is sent after the 503 leg and the backoff; land its stamp `phase` ms into a second.
    const answeredStamp = Math.ceil((clock + THETA) / 1000) * 1000 + 5_000 + phase;
    clock = answeredStamp - THETA - UP - BACKOFF - UP - DOWN;
    await a.login();
    const err = (clock + THETA) - a.serverNow();
    errs.push(err);
    assert.ok(Math.abs(err) <= 500 + (UP + DOWN) / 2,
      `login retried once after a 503 (backoff ${BACKOFF} ms), server ${phase} ms into its second: the REST clock is `
      + `${err} ms off - the offset is not read against the attempt that answered`);
  }
  ok(`a retried login reads the clock against the answering attempt (errors ${errs.join(', ')} ms)`);

  console.log(`\nPASS ${pass}/${EXPECTED}`);
})().catch((e) => { console.error('FAIL', e && e.message ? e.message : e); process.exit(1); });
