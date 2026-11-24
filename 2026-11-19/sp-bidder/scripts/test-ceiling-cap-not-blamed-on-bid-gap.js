'use strict';
/**
 * A SHIPPER CEILING THAT COLLAPSES THE DESK'S PRICES IS NOT REPORTED AS A BID-GAP SHORTFALL.
 *
 * Regression target: R30b-ceiling-cap-shortfall. GET /price/:token/preview returns `shortfall`
 * (ladderShortfall) whenever planPreview's rungsFitting < rungsRequested. When the shipper ceiling
 * reshapes the ladder - capLadderToCeiling merging rungs onto the cap, or the single bid at a ceiling
 * that sits between the minimum-margin guard and the lowest band price - planPreview still reports
 * rungsRequested as the desk's own count. The page then tells the desk only some prices can be sent
 * because "this customer needs Rs 100 between bids", and offers a last price that "sends all three",
 * which no price under that ceiling can do. The bid gap did not cause it and the fix it names is false.
 * The ceiling's own note already states what the ceiling did.
 *
 * Cost 100,000, band [12.6, 7.2, 6.3], minimum 5, minimum bid difference 100:
 *   band prices round(100000 x 1.126 / 1.072 / 1.063) = [112600, 107200, 106300]
 *   guard max(100000, round(100000 x 1.05))            = 105,000
 *   ceiling 105,500 (guard <= 105,500 < 106,300)       -> one bid, ladder [105500]
 *   ceiling 107,000 -> 107200 is lowered onto 107000   -> ladder [107000, 106300]
 * In both, `shortfall` and `notice` must be null and `ladder` / `fittingPrices` list what goes out.
 *
 * WHAT MUST NOT MOVE:
 *   - with no ceiling, a minimum bid difference of 5,000 still yields a shortfall naming Rs 5,000:
 *     the middle price must sit <= 112600 - 5000 = 107600 and >= 106300 + 5000 = 111300, which is
 *     empty, so it drops -> ladder [112600, 106300], 2 of 3 sent, and the price that sends all three
 *     is 112600 - 2 x 5000 = 102,600;
 *   - a ceiling above the opening price (120,000) leaves the preview exactly as with no ceiling,
 *     shortfall included, at both minimum bid differences;
 *   - planPreview's ladder / floor / rungCount for the two ceiling cases: [105500] / 105500 / 1 and
 *     [107000, 106300] / 106300 / 2.
 *
 * Offline: the /price routes over 127.0.0.1 in mock mode on a memory store, temp data dir.
 *
 *   node scripts/test-ceiling-cap-not-blamed-on-bid-gap.js
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ceiling-cap-shortfall-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');
const { app, requests, engine } = require('../src/web/server');

const COST = 100_000;
const IN_GAP = 105_500;
const PARTIAL = 107_000;
const ABOVE_OPENING = 120_000;
const WIDE_GAP = 5_000;

let SERVER = null;
let BASE = null;
let loadSeq = 0;
const now = Date.now();

const rulesFor = (ceilingPrice, minDecrement) => ({ ceilingPrice, pricingMode: 'flat', minDecrement });
const mkLoad = (ceilingPrice, minDecrement) => ({
  id: `CAP-SHORTFALL-${loadSeq++}`, lane: { origin: 'Vapi', destination: 'Nagpur' }, equipment: '32 Feet', units: 1,
  companyName: 'Acme Coatings', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: rulesFor(ceilingPrice, minDecrement),
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

async function previewFor(ceilingPrice, minDecrement = 100) {
  const r = await requests.createForLoad(mkLoad(ceilingPrice, minDecrement));
  const res = await get(`${BASE}/price/${r.id}/preview?cost=${COST}`);
  assert.strictEqual(res.status, 200, `preview answered ${res.status}: ${res.text.slice(0, 200)}`);
  return res.json;
}

let ran = 0, pass = 0;
const EXPECTED = 5;
const FAILURES = [];
process.on('exit', (code) => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  if (ran === EXPECTED && pass === EXPECTED) {
    if (code === 0) console.log(`\nPASS ceiling cap not blamed on bid gap: ${pass}/${EXPECTED} checks passed`);
    return;
  }
  console.error(`\nFAILED: ${ran}/${EXPECTED} checks ran, ${pass} passed - a shipper ceiling that collapses the desk's `
    + 'prices is reported as a minimum-bid-gap shortfall, with a corrective price that cannot send them all');
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

function assertCeilingOwnsTheStory(pv, expected, ceiling) {
  assert.deepStrictEqual(pv.ladder, expected, `preview ladder under ceiling ${ceiling}: ${pv.ladder}`);
  assert.deepStrictEqual(pv.fittingPrices, expected, `fittingPrices under ceiling ${ceiling}: ${pv.fittingPrices}`);
  assert.strictEqual(pv.shortfall, null,
    `ceiling ${ceiling} reshaped the ladder to [${pv.ladder}] and the preview blames the bid gap `
    + `(rungsRequested ${pv.rungsRequested}, rungsFitting ${pv.rungsFitting}): `
    + `${JSON.stringify(pv.shortfall)}`);
  assert.strictEqual(pv.notice, null, `notice under ceiling ${ceiling}: ${pv.notice}`);
}

(async () => {
  console.log('ceiling cap not blamed on bid gap');
  SERVER = app.listen(0, '127.0.0.1');
  await new Promise((r) => SERVER.once('listening', r));
  BASE = `http://127.0.0.1:${SERVER.address().port}`;

  await check('1 gap-ceiling-no-shortfall: ceiling 105,500 previews [105500] with shortfall and notice null', async () => {
    assertCeilingOwnsTheStory(await previewFor(IN_GAP), [IN_GAP], IN_GAP);
  });

  await check('2 partial-ceiling-no-shortfall: ceiling 107,000 previews [107000, 106300] with shortfall and notice null', async () => {
    assertCeilingOwnsTheStory(await previewFor(PARTIAL), [PARTIAL, 106_300], PARTIAL);
  });

  await check('3 control-real-bid-gap: no ceiling, minimum bid difference 5,000 keeps a shortfall naming Rs 5,000', async () => {
    const pv = await previewFor(null, WIDE_GAP);
    assert.deepStrictEqual(pv.ladder, [112_600, 106_300], `ladder: ${pv.ladder}`);
    assert.strictEqual(pv.rungsRequested, 3, `rungsRequested: ${pv.rungsRequested}`);
    assert.strictEqual(pv.rungsFitting, 2, `rungsFitting: ${pv.rungsFitting}`);
    assert.ok(pv.shortfall, 'a load whose minimum bid difference drops a price lost its shortfall');
    assert.ok(pv.shortfall.fact.includes('5,000'), `shortfall does not name the Rs 5,000 gap: ${pv.shortfall.fact}`);
    // Ruling 67: 1,02,600 sits under the guard 1,05,000, so no corrective figure and no action line.
    assert.strictEqual(pv.shortfall.costTarget, null, `costTarget: ${pv.shortfall.costTarget}`);
    assert.strictEqual(pv.shortfall.action, null, `action: ${pv.shortfall.action}`);
  });

  await check('4 control-ceiling-above-opening: ceiling 120,000 previews exactly as no ceiling, at gaps 100 and 5,000', async () => {
    for (const md of [100, WIDE_GAP]) {
      const capped = await previewFor(ABOVE_OPENING, md);
      const open = await previewFor(null, md);
      assert.strictEqual(capped.ceiling, ABOVE_OPENING, `ceiling field: ${capped.ceiling}`);
      const { ceiling: _drop, ...rest } = capped;
      assert.deepStrictEqual(rest, open, `gap ${md}: a ceiling above the opening changed the preview`);
    }
  });

  await check('5 control-planPreview-ladder: [105500]/105500/1 and [107000, 106300]/106300/2', () => {
    const band = { cost: COST, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 5 };
    const plan = (k) => engine.planPreview({ id: `PLAN-${k}`, rules: rulesFor(k, 100), companyName: 'Acme Coatings' }, band);
    const g = plan(IN_GAP);
    assert.deepStrictEqual([g.ladder, g.floor, g.rungCount], [[IN_GAP], IN_GAP, 1], `gap plan: ${JSON.stringify(g)}`);
    const p = plan(PARTIAL);
    assert.deepStrictEqual([p.ladder, p.floor, p.rungCount], [[PARTIAL, 106_300], 106_300, 2], `partial plan: ${JSON.stringify(p)}`);
  });

  SERVER.close();
  process.exit(ran === EXPECTED && pass === EXPECTED ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
