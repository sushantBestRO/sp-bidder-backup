'use strict';
/**
 * The rupee amount the desk types into the band editor must be the rupee amount that goes out.
 *
 * The band editor shows a % box and a "= Rs" box per rung, but ONLY the % is posted - the Rs box is
 * a display mirror. The Rs -> % conversion used to round to one decimal, and one decimal of a
 * percent is 0.1% of cost: Rs 62 on a Rs 62,017 load. So a desk typing the round figures a shipper
 * demanded (68,000 / 65,000 / 64,000) sent 67,971 / 64,994 / 64,002, and the page went on showing
 * the round numbers until the save overwrote them. Section A is that exact load.
 *
 * Parses the SHIPPED bytes over real HTTP and evaluates the conversion lifted OUT of them, the same
 * reasoning as test-price-page-platform.js: this logic lives inside a template literal, so a source
 * read cannot prove what reached the browser. The step attribute is asserted for the same reason it
 * had to change - both forms validate natively, so step="0.1" makes the browser refuse a submit
 * carrying a more precise value before any handler runs, and a revert there silently restores the
 * bug with the conversion still correct.
 *
 *   node scripts/test-price-rupee-precision.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rupee-precision-'));

const http = require('http');
const { app, requests } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET' },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => resolve({ status: res.statusCode, text: buf })); });
    r.on('error', reject);
    r.end();
  });
}

/** Lift a function's source out of the shipped page by its anchors, so what runs here is what ships. */
function lift(html, startAnchor, endAnchor) {
  const a = html.indexOf(startAnchor);
  if (a < 0) throw new Error('not in the shipped page: ' + startAnchor);
  const b = html.indexOf(endAnchor, a);
  if (b < 0) throw new Error('unterminated in the shipped page: ' + startAnchor);
  return html.slice(a, b + endAnchor.length);
}

// The one-decimal conversion this fix replaced. Kept verbatim so every case below can show it
// actually failed - a round-trip test that the old code also passed would be proving nothing.
const OLD_pctForRs = (rs, cv) => Math.round((rs / cv - 1) * 1000) / 10;

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const now = Date.now();

  const load = {
    id: 'SP-PRECISION-1', lane: { origin: 'Bhiwandi', destination: 'Panchkula' },
    equipment: 'Trailer', units: 1, quoteType: 'FTL', companyName: 'Durian Industries Ltd',
    closesAt: now + 20 * 60000, startsAt: now - 60000, status: 'live',
    softClose: true, closeModelKnown: true,
  };
  const r = await requests.createForLoad(load, { deadlineAt: now + 18 * 60000 });
  const res = await get(base + '/price/' + r.id);
  ok(res.status === 200, 'price page renders (status ' + res.status + ')');
  const html = res.text;

  // ---------------------------------------------------------------------------------------
  console.log('\nA. the load from the report: cost 62,017, the desk types three round figures');
  // ---------------------------------------------------------------------------------------
  const src = lift(html, 'function priceOf(p,cv){', ':null;}')
    + '\n' + lift(html, 'function pctForRs(rs,cv){', '.toFixed(6));}')
    + '\nreturn { priceOf: priceOf, pctForRs: pctForRs };';
  // eslint-disable-next-line no-new-func
  const lifted = new Function(src)();
  const priceOf = lifted.priceOf;
  const pctForRs = lifted.pctForRs;
  ok(typeof pctForRs === 'function' && typeof priceOf === 'function',
    'both halves of the conversion were lifted out of the SHIPPED page, not read from source');

  const COST = 62017;
  for (const typed of [68000, 65000, 64000]) {
    const pct = pctForRs(typed, COST);
    ok(priceOf(pct, COST) === typed,
      'typed Rs ' + typed + ' -> ' + pct + '% -> bids Rs ' + priceOf(pct, COST) + ' (exactly what was typed)');
    ok(priceOf(OLD_pctForRs(typed, COST), COST) !== typed,
      '  and the one-decimal conversion this replaced sent Rs ' + priceOf(OLD_pctForRs(typed, COST), COST) + ' instead');
  }

  // ---------------------------------------------------------------------------------------
  console.log('\nB. exact for any rupee target a desk could type, across the cost range BRL sees');
  // ---------------------------------------------------------------------------------------
  let swept = 0, exact = 0, oldExact = 0;
  for (const cost of [8000, 17350, 38000, 62017, 125000, 499999, 875400]) {
    // every rung the band editor can hold, from a fat opening margin down to break-even
    for (let pctTarget = 0; pctTarget <= 15; pctTarget += 0.37) {
      const typed = Math.round(cost * (1 + pctTarget / 100));
      swept++;
      if (priceOf(pctForRs(typed, cost), cost) === typed) exact++;
      if (priceOf(OLD_pctForRs(typed, cost), cost) === typed) oldExact++;
    }
  }
  ok(swept > 250, 'swept ' + swept + ' cost x target pairs');
  ok(exact === swept, 'every one of ' + swept + ' round-trips is exact (' + exact + '/' + swept + ')');
  ok(oldExact < swept, 'the one-decimal conversion was exact on only ' + oldExact + '/' + swept + ' of them');

  // ---------------------------------------------------------------------------------------
  console.log('\nC. no gratuitous digits: the shortest precision that works is the one used');
  // ---------------------------------------------------------------------------------------
  // A target that one decimal already reproduces must still come back as that one decimal - the
  // desk reads this box, and 9.600000 where 9.6 is exact is a worse number to hand back.
  const clean = priceOf(9.6, COST);
  ok(pctForRs(clean, COST) === 9.6,
    'Rs ' + clean + ' comes back as 9.6, not a padded 9.600000 - one decimal already reproduces it');
  const messy = pctForRs(68000, COST);
  ok(String(messy).length > 3 && priceOf(messy, COST) === 68000,
    'Rs 68,000 needs more than one decimal (' + messy + '%) and gets exactly as many as it needs');
  ok(pctForRs(Math.round(COST), COST) === 0,
    'a rupee target equal to cost is 0% - the break-even edge does not drift off zero');

  // ---------------------------------------------------------------------------------------
  console.log('\nD. the % input accepts what the conversion now produces');
  // ---------------------------------------------------------------------------------------
  // Both /price forms validate natively (neither carries novalidate), so the browser refuses a
  // submit whose value violates step BEFORE the submit handler runs. step="0.1" would reject every
  // value section A depends on, with the conversion still perfectly correct - which is exactly how
  // this would regress unnoticed.
  const rungInputs = html.match(/<input type="number"[^>]*name="m_\d+"[^>]*>/g) || [];
  ok(rungInputs.length >= 3, 'found ' + rungInputs.length + ' rung inputs on the page');
  ok(rungInputs.every((t) => t.indexOf('step="any"') >= 0),
    'every rung % input carries step="any"');
  ok(!rungInputs.some((t) => t.indexOf('step="0.1"') >= 0),
    'no rung % input is back on step="0.1" - that alone would restore the bug');

  server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  // Completion sentinel: the runner grades by EXIT CODE only, so a file that exited early would
  // read as a green zero-assertion pass. Nothing below this line, and the count is asserted.
  if (pass < 17) { console.error('FAIL - only ' + pass + ' assertions ran; expected at least 17'); process.exit(1); }
  console.log('test-price-rupee-precision: COMPLETE');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
