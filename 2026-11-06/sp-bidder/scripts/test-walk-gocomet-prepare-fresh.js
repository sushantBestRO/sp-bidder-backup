'use strict';
/**
 * @requires-summary-line
 * T9 final-window walk: the quote under GoComet's clock-decided last step (owner decision of 26 Sep:
 * a late read never leaves an outranked round unbid).
 *
 * The last step decided on the clock has no time for the two quote reads a cold write takes, so its
 * quote is prepared 4 s ahead of it (a prepared quote is trusted for 5 s, ruling 61), even when the walk
 * prepared one earlier in the round. A quote still fresh then is not read again (ruling 61 unchanged).
 * A round the tracker calls not final spends no reads on it. With the walk off nothing here runs.
 *
 * Harness units: landMs 6,000 + safety 1,500 -> the clock-decided step fires at 7,500 and its quote is
 * prepared at 11,500.
 *
 *   node scripts/test-walk-gocomet-prepare-fresh.js
 */
const H = require('./lib/walk-harness');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');

const EXPECTED = 3;
const BAND = { cost: 50_000, marginsPct: [9, 7.2, 1.8], minMarginPct: 1 };
const walkGc = H.walkCfg('gc');
const UNCAPPED = { roundPolicy: { finalAfterExtensions: null } };

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const token = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1' })}.sig`;
const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const FREIGHT = 'freight_charges_custom_charge_40ft';
const quoteDoc = () => ({
  id: 'Q1',
  charges_list: { '11_freight_charges': { [FREIGHT]: { units: 1, unit_name: 'TRUCK', price: 40000 } } },
  total_charges: { total: { units: 1.0, quote_units: 1.0, unit_name: 'TRUCK', total: 40000 } },
});

async function adapterRig() {
  let t = 1_000_000;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ at: t, method: (init && init.method) || 'GET' });
    if (url.includes('/bidding-data')) return resp(200, { data: { bid_closing_in: 5, vendor_rank: 2, revisions_left: 3, total_revisions: 0 } });
    if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quoteDoc()]);
    if (init.method === 'PUT') return resp(200, { data: { quote_rank: 1, can_submit_quote: true } });
    return resp(404, {});
  };
  const adapter = new GoCometAdapter({ token: token(), bidEnabled: true, fetchImpl, now: () => t,
    sleep: async (ms) => { await new Promise((r) => setImmediate(r)); t += ms; },
    minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000, snipeBudgetMs: 4500 });
  await adapter.login();
  await adapter.getAuctionState('ENQ-FRESH');
  if (adapter._pendingPrepare) await adapter._pendingPrepare;
  return { adapter, calls, advance: (ms) => { t += ms; } };
}
const methods = (list) => list.map((c) => c.method).join(', ') || 'none';

(async () => {
  console.log('T9 walk - GoComet clock-decided step: its quote is prepared ahead of it');

  await H.check('control: a quote still fresh is not read again (ruling 61 as before)', async () => {
    const bad = [];
    const { adapter, calls, advance } = await adapterRig();
    advance(1000);
    const before = calls.length;
    await adapter.prepareQuote('ENQ-FRESH');
    const prep = calls.slice(before);
    if (prep.length) bad.push(`a quote 1 s old prepared again with ${methods(prep)}; expected no reads`);
    return bad.join('; ') || null;
  });

  await H.check('pin: an uncapped round outranked prepares the clock-decided step quote 4,000 ahead of it (11,500), even after an earlier prepare this round', async () => {
    const bad = [];
    const r = H.load({ platform: 'gc', band: BAND, gc: UNCAPPED, walk: walkGc });
    r.seedStanding(0, 2);
    await r.at(60_000, { rank: 2 });
    await r.at(20_000, { rank: 2 });
    if (r.m._walkClockAtMs !== 7_500) bad.push(`HARNESS: the fallback was armed for ${r.m._walkClockAtMs}`);
    r.m._walkPreparedRoundId = r.eng.roundVerdict(r.m).roundId;
    H.setNow(r.close - 11_500);
    if (typeof r.eng._walkClockPrepare === 'function') r.eng._walkClockPrepare(r.m);
    await new Promise((res) => setImmediate(res));
    r.done();
    const p = r.ctrl.prepares;
    if (p.length !== 1 || p[0].cd !== 11_500) bad.push(`prepareQuote calls ${JSON.stringify(p)}; expected one at 11,500`);
    return bad.join('; ') || null;
  });

  await H.check('control: a round the tracker calls not final, and the walk off, spend no reads on it', async () => {
    const bad = [];
    const nf = H.load({ platform: 'gc', band: BAND, gc: { roundPolicy: { finalAfterExtensions: 3 } }, walk: walkGc });
    nf.seedStanding(0, 2);
    await nf.at(60_000, { rank: 2 });
    await nf.at(20_000, { rank: 2 });
    if (nf.eng.roundVerdict(nf.m).verdict !== 'NOT_FINAL') bad.push(`HARNESS: verdict ${nf.eng.roundVerdict(nf.m).verdict}`);
    H.setNow(nf.close - 11_500);
    if (typeof nf.eng._walkClockPrepare === 'function') nf.eng._walkClockPrepare(nf.m);
    await new Promise((res) => setImmediate(res));
    nf.done();
    if (nf.ctrl.prepares.length) bad.push(`NOT_FINAL prepared ${JSON.stringify(nf.ctrl.prepares)}`);
    const off = H.load({ platform: 'gc', band: BAND, gc: UNCAPPED });
    off.seedStanding(0, 2);
    await off.at(60_000, { rank: 2 });
    await off.at(20_000, { rank: 2 });
    H.setNow(off.close - 11_500);
    if (typeof off.eng._walkClockPrepare === 'function') off.eng._walkClockPrepare(off.m);
    await new Promise((res) => setImmediate(res));
    off.done();
    if (off.ctrl.prepares.length) bad.push(`walk off prepared ${JSON.stringify(off.ctrl.prepares)}`);
    if (off.m._walkClockAtMs != null) bad.push(`walk off armed a clock fallback for ${off.m._walkClockAtMs}`);
    return bad.join('; ') || null;
  });

  H.finish('T9 walk GoComet clock-decided step quote', EXPECTED);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
