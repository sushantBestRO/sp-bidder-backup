'use strict';
/**
 * THE LOSING SIDE OF TWO CAPTURES SEES AN ERROR ON THE PRICE SCREEN, NOT THE LOAD'S CURRENT PAGE.
 *
 * Regression target: A009, owner feedback. With capture() now a compare-and-set, the second of two
 * captures racing on one load is refused. The route answered that refusal by rendering the load's
 * current page - the desk's number vanished behind a page showing someone else's, with nothing said.
 * The owner's rule: an error on the price screen, in these words:
 *   "Not saved: another price was saved for this load just now. Reload to see it."
 *
 * The race is forced, not hoped for: the two captures' reads of the request are held at a barrier
 * until both have read, so both pass the open-status check before either writes.
 *
 *   node scripts/test-capture-race-shows-error.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_PLAUSIBLE_COST = '1';
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '0';
process.env.SP_MARGINS_PCT = '9,5,1';
process.env.SP_MIN_MARGIN_PCT = '1';
process.env.LOG_LEVEL = 'silent';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-capture-race-'));

const http = require('http');
const { app, requests, stacks } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };
const WORDS = 'Not saved: another price was saved for this load just now. Reload to see it.';

function post(base, url, { json, form }) {
  const body = json ? JSON.stringify(json) : Object.entries(form).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const type = json ? 'application/json' : 'application/x-www-form-urlencoded';
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': type, 'content-length': Buffer.byteLength(body) } },
    (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json: j, text: b }); }); });
    r.on('error', reject); r.write(body); r.end();
  });
}
const load = (id) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1, quoteType: 'FTL',
  companyName: 'Waaree Energies', closesAt: Date.now() + 40 * 60_000, startsAt: Date.now() - 60_000,
  softClose: false, closeModelKnown: true, status: 'live' });

// capture() runs against a view of the store whose request read waits until both captures have read.
const realCapture = requests.capture;
function raceNextTwoCaptures() {
  let waiting = [];
  const barrierGet = async (token) => {
    const doc = await requests.getByToken(token);
    await new Promise((resolve) => { waiting.push(resolve); if (waiting.length === 2) { waiting.forEach((w) => w()); waiting = []; } });
    return doc;
  };
  let left = 2;
  requests.capture = function (...a) {
    if (left <= 0) return realCapture.apply(this, a);
    left -= 1;
    if (left === 0) requests.capture = realCapture;
    return realCapture.apply(Object.create(requests, { getByToken: { value: barrierGet } }), a);
  };
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const [label, as] of [['the price page (form post)', 'form'], ['a JSON caller', 'json']]) {
    console.log(`\n${label}`);
    const r = await requests.createForLoad(load(`RACE-${as}`));
    raceNextTwoCaptures();
    const [a, b] = await Promise.all([
      post(base, `/price/${r.id}`, { [as]: { cost: '29000' } }),
      post(base, `/price/${r.id}`, { [as]: { cost: '41000' } }),
    ]);
    const won = [a, b].filter((x) => x.status === 200);
    const lost = [a, b].filter((x) => x.status !== 200);
    ok(won.length === 1 && lost.length === 1, `one capture lands, one is refused (HTTP ${a.status}, ${b.status})`);
    const loser = lost[0];
    const shown = loser ? (as === 'json' ? ((loser.json && loser.json.error) || '') : loser.text.replace(/&#39;/g, "'")) : '';
    ok(!!loser && loser.status === 409, `the refusal is a 409 (HTTP ${loser && loser.status})`);
    ok(shown.includes(WORDS), `and says, on the screen, "${WORDS}" (${as === 'json' ? shown : (shown.includes(WORDS) ? 'found' : 'not in the page')})`);
    const rec = await requests.getByToken(r.id);
    const m = stacks[0].engine.monitors.get(`RACE-${as}`);
    ok(!!m && rec.price && m.ladder[m.ladder.length - 1] === Math.round(rec.price.cost * 1.01),
      `the record and the armed ladder are the winner's (cost ${rec.price && rec.price.cost}, floor ${m && m.floor})`);
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
