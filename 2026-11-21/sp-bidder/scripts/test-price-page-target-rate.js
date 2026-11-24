'use strict';
/**
 * What the /price page shows a pricer on a shipper target rate, over real HTTP.
 *
 * The tiles are assembled inside template literals, so a source read cannot catch a rendering
 * mistake - the same reasoning as test-price-page-gocomet-facts.js. These fetch the shipped bytes.
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-gc-target-'));

const http = require('http');
const assert = require('assert');
const { app, requests } = require('../src/web/server');
const { publicSeg } = require('../src/pricing/priceRequests');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log('  ok  ' + m); };

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET' },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => resolve({ status: res.statusCode, text: buf })); });
    r.on('error', reject);
    r.end();
  });
}

function post(url, form) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } },
    (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => resolve({ status: res.statusCode, text: buf })); });
    r.on('error', reject);
    r.end(body);
  });
}

const AUCTION_CLOSE = Date.now() - 45 * 60_000;
const TARGET_DEADLINE = Date.now() + 14 * 60_000;
const LOAD = {
  id: '260817N3VH', lane: { origin: 'Bhuj', destination: 'Chennai' },
  equipment: '40FTHB', units: 1, companyName: 'Waaree Energies Ltd.',
  shipperRef: '3262600276', closesAt: AUCTION_CLOSE, rules: {},
};

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const tp = await requests.createForTargetPrice(LOAD, {
      targetPricePerUnit: 98000, standingPricePerUnit: 102695,
      targetDeadlineMs: TARGET_DEADLINE, negotiationRound: 'r1',
      comment: 'Immediate Requirement', chargeLineCount: 1, platformKey: 'gocomet',
    });
    const page = await get(`${base}/price/${publicSeg(tp)}`);
    ok(page.status === 200, 'the target-rate ask opens a live capture page');
    const html = page.text;

    ok(/Customer wants a lower rate/i.test(html), 'the page leads with what the event is');
    ok(html.includes('98,000'), 'their number is on the page');
    ok(html.includes('1,02,695'), 'ours is beside it');
    ok(/Immediate Requirement/.test(html), "the customer's own note is shown");
    ok(/Their offer ends at/.test(html), 'the shipper deadline is stated as a hard stop');
    ok(/hard stop/i.test(html), 'and the copy says it is unlike an auction close');
    ok(!/vehicle types/i.test(html), 'a single-vehicle load carries no hand-quote warning');
    ok(/name="cost"/.test(html), 'the cost form is still on the page - the desk can answer');

    // No jargon or internals reach a page the desk reads.
    ok(!/negotiat|indicative_charges|is_negotiating/i.test(html), 'no platform jargon on the page');

    // A multi-vehicle-type target must say it cannot be submitted for them.
    const multi = await requests.createForTargetPrice({ ...LOAD, id: '260817Q9LG' }, {
      targetPricePerUnit: 190000, standingPricePerUnit: 216200,
      targetDeadlineMs: TARGET_DEADLINE, negotiationRound: 'r1',
      chargeLineCount: 2, autoBiddable: false, platformKey: 'gocomet',
    });
    const mpage = await get(`${base}/price/${publicSeg(multi)}`);
    ok(mpage.status === 200, 'the multi-vehicle target also opens');
    ok(/2 vehicle types/i.test(mpage.text), 'the vehicle-type count is named');
    ok(/by hand/i.test(mpage.text), 'and the desk is told to enter it on the portal');

    // A NORMAL ask must be byte-unaffected by all of the above.
    const plain = await requests.createForLoad({ ...LOAD, id: 'PLAIN1', closesAt: Date.now() + 30 * 60_000 },
      { deadlineAt: Date.now() + 29 * 60_000, platformKey: 'gocomet' });
    const ppage = await get(`${base}/price/${publicSeg(plain)}`);
    ok(ppage.status === 200, 'an ordinary price ask still renders');
    ok(!/Customer wants a lower rate/i.test(ppage.text), 'and carries no target banner');
    ok(/Enter your cost by/.test(ppage.text), 'keeping its original cutoff wording');

    // THE REGRESSION THIS FEATURE SHIPPED WITH. Answering a target rate used to fall through to
    // armFromRequest, and bidEngine.arm short-circuits on the load's existing (finalized) auction
    // monitor - so the desk's cost re-planned nothing, placeBid was never reached, and the page
    // still said "Bidding will start automatically" over a ladder built from a different cost.
    // The capture must take the target branch instead, and must never render the armed copy.
    {
      const answerable = await requests.createForTargetPrice({ ...LOAD, id: '260817ANSW' }, {
        targetPricePerUnit: 98000, standingPricePerUnit: 102695,
        targetDeadlineMs: TARGET_DEADLINE, negotiationRound: 'r1', platformKey: 'gocomet',
      });
      const res = await post(`${base}/price/${publicSeg(answerable)}`, { cost: '80000' });
      ok(!/Bidding will start automatically/i.test(res.text),
        'answering a target rate never claims the auction bot is now running');
      ok(!/It will open at/i.test(res.text),
        'and never describes a ladder - a target rate is one bid, not a descent');
      ok(/Sent at the customer rate|Not sent/i.test(res.text),
        'it renders the target-rate outcome page instead');
      const after = await requests.getTargetPriceRequest('260817ANSW', 'r1', 'gocomet');
      ok(after && after.status !== 'awaiting_price',
        'and the ask is closed out rather than left waiting for a price');
    }

    const EXPECTED = 20;
    assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
    console.log(`\n${pass}/${EXPECTED} checks passed`);
  } finally {
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
