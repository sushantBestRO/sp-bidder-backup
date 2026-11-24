'use strict';
/**
 * THE PRICE PAGE'S ONE-TAP CORRECTIVE NEVER ASKS FOR A LAST PRICE BELOW THE LOAD'S MINIMUM MARGIN,
 * AND ITS COUNT SENTENCES NEVER COUNT PRICES THE DESK DID NOT TYPE.
 *
 * Regression target: T4 D2 (R2-4), as it stands after the minimum became a guard (M0).
 * The half where the band appended the minimum as a fourth price is gone. Two mechanisms remain:
 *
 * 1. THE CORRECTIVE IS BOUNDED AT COST, NOT AT THE MINIMUM. When the minimum bid difference drops a
 *    price, ladderShortfall offers "Set your last price at Rs X or less" and puts X on a button that
 *    rewrites the desk's lowest margin row. readPlan's only check on X is `X > trueCost`. The owner
 *    ruling is that the corrective stays at or above the desk's floor, which is the minimum-margin
 *    guard max(round(cost), round(cost x (1 + minimum/100))). Today the button offers prices under
 *    it: Rs 1,02,600 on a load whose guard is Rs 1,05,000, and Rs 50,001 on a load whose guard is
 *    Rs 56,000. Pressing it moves the desk's lowest margin under the customer minimum.
 *
 * 2. THE +1 TOLERANCE. countsAreDeskFacing is `rungsRequested <= deskPriceCount + 1`. The +1 was
 *    there for the appended minimum rung, which no longer exists. It now lets a fine ladder (soft-close
 *    allowlisted shipper, bid cap above 3) of exactly one more rung than the desk typed through as the
 *    desk's own count, so the page says "Your third price will go out at Rs 1,07,300 instead of
 *    Rs 1,07,200" about the desk's middle price on a three-row form.
 *
 * Fixtures (minimum bid difference in brackets):
 *   A  cost 1,00,000, band [12.6, 7.2, 6.3], minimum 5 (5,000). Band prices [112600, 107200, 106300];
 *      the middle needs <= 107600 and >= 111300, so it drops: 2 of 3 sent. Guard 105,000. The target
 *      112600 - 2 x 5000 = 102,600 is under the guard.
 *   B  cost 50,000, band [24.002, 18, 12], minimum 12 (6,000). Prices [62001, 59000, 56000]; the middle
 *      drops, 2 of 3 sent. Guard 56,000. Target 62001 - 2 x 6000 = 50,001 is under it.
 *   C  cost 38,000, band [14, 11.5, 10.3], minimum 6.3 (1,000). Prices [43320, 41914]; the middle
 *      11.5 price drops, 2 of 3 sent. Guard 40,394. Target 43320 - 2 x 1000 = 41,320 is above it.
 *   D  fixture A's band with (1,000) on an allowlisted shipper, bid cap 4: fine ladder
 *      [112600, 109900, 107300, 106300], four rungs from three typed margins.
 *
 * WHAT MUST NOT MOVE:
 *   - a corrective at or above the guard is still offered and still works (C: Rs 41,320, and pressing
 *     it sends all three);
 *   - suppressing the figure does not suppress the fact: A still says 2 of 3 and names Rs 5,000;
 *   - a three-price band keeps its count sentences, and a fine ladder of five rungs stays silent.
 *
 * Offline: engine previews in-process, and the /price preview route over 127.0.0.1 in mock mode on a
 * memory store with a temp data dir.
 *
 *   node scripts/test-shortfall-corrective-above-minimum.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '0';
process.env.SP_MIN_PLAUSIBLE_COST = '1';
process.env.SP_MARGINS_PCT = '12.6,7.2,6.3';
process.env.SP_MIN_MARGIN_PCT = '5';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs');
const path = require('path');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-corrective-above-minimum-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');
const { app, requests } = require('../src/web/server');
const { BidEngine } = require('../src/engine/bidEngine');
const { ladderShortfall, ladderNotice } = require('../src/pricing/ladderNotice');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
quiet.child = () => quiet;
const caps = { standingPriceVisible: false, minDecrement: 100, revisionLimit: null, closeModel: 'unknown' };
const plain = new BidEngine({ name: 'plain', capabilities: () => caps }, null, { log: quiet });
const allowlisted = new BidEngine({ name: 'soft', capabilities: () => caps }, null,
  { log: quiet, softClose: { enabled: true, shippers: ['Havells'], mode: 'shadow' } });

const A = { cost: 100_000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 5 };
const B = { cost: 50_000, marginsPct: [24.002, 18, 12], minMarginPct: 12 };
const C = { cost: 38_000, marginsPct: [14, 11.5, 10.3], minMarginPct: 6.3 };
const guardOf = (band) => Math.max(Math.round(band.cost), Math.round(band.cost * (1 + band.minMarginPct / 100)));

function page(engine, band, rules, companyName = 'Acme Coatings') {
  const pv = engine.planPreview({ id: 'PV', rules, companyName }, band);
  return { pv, shortfall: ladderShortfall(pv), notice: ladderNotice(pv) };
}

const rupeesIn = (s) => (String(s || '').match(/Rs [0-9,]+/g) || []).map((x) => Number(x.slice(3).replace(/,/g, '')));

function assertCorrectiveAtOrAboveGuard(shortfall, guard, where) {
  assert.ok(shortfall, `precondition (${where}): the minimum bid difference drops a price, so there is a shortfall`);
  const t = shortfall.costTarget;
  assert.ok(t == null || t >= guard,
    `${where}: the button asks for a last price of Rs ${t}, under the minimum-margin guard Rs ${guard} - `
    + `readPlan bounds the corrective at cost, not at the minimum ("${shortfall.action}")`);
  const low = rupeesIn(shortfall.action).filter((n) => n < guard);
  assert.deepStrictEqual(low, [], `${where}: the action sentence names a price under the guard: "${shortfall.action}"`);
}

let SERVER = null;
let BASE = null;
let loadSeq = 0;
const now = Date.now();
const mkLoad = (minDecrement) => ({
  id: `CORRECTIVE-${loadSeq++}`, lane: { origin: 'Vapi', destination: 'Nagpur' }, equipment: '32 Feet', units: 1,
  companyName: 'Acme Coatings', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: { ceilingPrice: null, pricingMode: 'flat', minDecrement },
});
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); });
    }).on('error', reject);
  });
}

let ran = 0, pass = 0;
const EXPECTED = 7;
const FAILURES = [];
process.on('exit', (code) => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  if (ran === EXPECTED && pass === EXPECTED) {
    if (code === 0) console.log(`\nPASS shortfall corrective above minimum: ${pass}/${EXPECTED} checks passed`);
    return;
  }
  console.error(`\nFAILED: ${ran}/${EXPECTED} checks ran, ${pass} passed - the price page's corrective asks for a last `
    + 'price under the minimum-margin guard, or its count sentences count engine rungs as the desk\'s own prices');
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});
async function check(name, fn) {
  ran++;
  try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) {
    FAILURES.push({ name, message: (e && e.message) || String(e) });
    console.log('  FAIL ' + name + '\n         ' + ((e && e.message) || e));
  }
}

(async () => {
  console.log('shortfall corrective above minimum');
  SERVER = app.listen(0, '127.0.0.1');
  await new Promise((r) => SERVER.once('listening', r));
  BASE = `http://127.0.0.1:${SERVER.address().port}`;

  await check('1 corrective-at-or-above-guard: fixture A (guard 1,05,000) offers no last price under the guard', () => {
    const { pv, shortfall } = page(plain, A, { minDecrement: 5_000 });
    assert.deepStrictEqual(pv.ladder, [112_600, 106_300], `precondition ladder: ${pv.ladder}`);
    assertCorrectiveAtOrAboveGuard(shortfall, guardOf(A), 'fixture A');
  });

  await check('2 corrective-at-or-above-guard: fixture B (minimum = lowest margin, guard 56,000) offers no last price under it', () => {
    const { pv, shortfall } = page(plain, B, { minDecrement: 6_000 });
    assert.deepStrictEqual(pv.ladder, [62_001, 56_000], `precondition ladder: ${pv.ladder}`);
    assertCorrectiveAtOrAboveGuard(shortfall, guardOf(B), 'fixture B');
  });

  await check('3 price-page-preview: GET /price/:token/preview on the inherited band A (5,000) offers no last price under 1,05,000', async () => {
    const r = await requests.createForLoad(mkLoad(5_000));
    const res = await get(`${BASE}/price/${r.id}/preview?cost=${A.cost}`);
    assert.strictEqual(res.status, 200, `preview answered ${res.status}: ${res.text.slice(0, 200)}`);
    assert.deepStrictEqual(res.json.ladder, [112_600, 106_300], `precondition ladder: ${res.json.ladder}`);
    assertCorrectiveAtOrAboveGuard(res.json.shortfall, guardOf(A), '/price preview');
  });

  await check('4 fine-ladder-not-desk-facing: fixture D (4 rungs from 3 typed margins) gets no count or ordinal sentence', () => {
    const { pv, shortfall, notice } = page(allowlisted, A, { minDecrement: 1_000, revisionLimit: 4 }, 'Havells India Ltd');
    assert.strictEqual(pv.ladder.length, 4, `precondition: a fine ladder of four rungs, got [${pv.ladder}]`);
    assert.strictEqual(pv.countsAreDeskFacing, false,
      `a ${pv.rungsRequested}-rung engine ladder on a 3-row form is treated as the desk's own count `
      + `(requested ${pv.rungsRequested} <= deskPriceCount 3 + 1); the page says: ${JSON.stringify(notice || shortfall)}`);
    assert.strictEqual(notice, null, `notice on a fine ladder: ${notice}`);
    assert.strictEqual(shortfall, null, `shortfall on a fine ladder: ${JSON.stringify(shortfall)}`);
  });

  await check('5 control-legit-corrective: fixture C keeps Rs 41,320 (guard 40,394), and pressing it sends all three', () => {
    const before = page(plain, C, { minDecrement: 1_000 });
    assert.deepStrictEqual(before.pv.ladder, [43_320, 41_914], `ladder: ${before.pv.ladder}`);
    assert.ok(before.shortfall, 'fixture C lost its shortfall');
    assert.strictEqual(before.shortfall.costTarget, 41_320, `costTarget: ${before.shortfall.costTarget}`);
    assert.strictEqual(before.shortfall.fact, 'Only 2 of your 3 prices can be sent - this customer needs Rs 1,000 between bids.');
    const pressed = page(plain, { ...C, marginsPct: [14, 11.5, 8.737] }, { minDecrement: 1_000 });
    assert.deepStrictEqual(pressed.pv.fittingPrices, [43_320, 42_320, 41_320], `after the tap: ${pressed.pv.fittingPrices}`);
    assert.strictEqual(pressed.shortfall, null, `shortfall after the tap: ${JSON.stringify(pressed.shortfall)}`);
  });

  await check('6 pin-fact-survives: fixture A still says 2 of 3 and names the Rs 5,000 gap', () => {
    const { shortfall } = page(plain, A, { minDecrement: 5_000 });
    assert.ok(shortfall, 'fixture A lost its shortfall entirely');
    assert.strictEqual(shortfall.fact, 'Only 2 of your 3 prices can be sent - this customer needs Rs 5,000 between bids.');
  });

  await check('7 control-count-contract: a 3-price band keeps its sentences; a 5-rung fine ladder stays silent', () => {
    const band = page(plain, A, { minDecrement: 1_000 });
    assert.deepStrictEqual(band.pv.ladder, [112_600, 107_300, 106_300], `band ladder: ${band.pv.ladder}`);
    assert.strictEqual(band.pv.countsAreDeskFacing, true, 'a three-row band is the desk\'s own count');
    assert.ok(band.notice, 'the moved middle price lost its notice');
    const five = page(allowlisted, A, { minDecrement: 1_000, revisionLimit: 5 }, 'Havells India Ltd');
    assert.strictEqual(five.pv.ladder.length, 5, `five-rung fine ladder: ${five.pv.ladder}`);
    assert.strictEqual(five.pv.countsAreDeskFacing, false);
    assert.strictEqual(five.notice, null);
    assert.strictEqual(five.shortfall, null);
  });

  SERVER.close();
  for (const e of [plain, allowlisted]) { try { e.kill('test done'); } catch (_) {} }
  process.exit(ran === EXPECTED && pass === EXPECTED ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
