'use strict';
/**
 * The price ask and the rate receipt say how the auction closes and how many bids it allows.
 *
 * The desk prices a soft-close load differently from a hard-close one, and a load that allows 3 bids
 * differently from one that allows 30. Both facts are on every load (SuperProcure: the branch's
 * extension time, extension count and bid count; GoComet: always auto-extending, 3 revisions, a round
 * cap per plant), but no WhatsApp message carried them. One short line under the close time, sized
 * for a phone: a segment the portal does not publish is left out, never guessed.
 *
 *   node scripts/test-wa-close-and-bids-line.js
 */
const assert = require('assert');
const { MemoryStore } = require('../src/store');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { Notifier } = require('../src/notify/notifier');
const { renderMessage } = require('../src/notify/waTemplates');

let pass = 0;
const ok = (n, m) => { console.log(`  ok  ${n}. ${m}`); pass++; };
const now = Date.now();

function load(id, over) {
  return Object.assign({ id, lane: { origin: 'Pune', destination: 'Nagpur' }, equipment: '32 FT', units: 1,
    companyName: 'Havells India Ltd.', closesAt: now + 60 * 60_000, startsAt: now - 60_000, status: 'live' }, over);
}

async function run(l, platformKey) {
  const store = new MemoryStore();
  const requests = new PriceRequestStore({ store, marginsPct: [12, 8, 5], minMarginPct: 3 });
  const req = await requests.createForLoad(l, { deadlineAt: now + 58 * 60_000, platformKey });
  const sent = [];
  const notifier = new Notifier({ mode: 'dashboard', baseUrl: 'http://h', log: () => {}, store });
  notifier.alert = async (kind, data) => { sent.push({ kind, data }); return { delivered: true }; };
  const ask = renderMessage('price_needed', await notifier._priceNeededData(req));
  await requests.capture(req.id, { cost: 30000 });
  await notifier.confirmSubmitted(await requests.getByToken(req.id), [33600, 32400, 31500]);
  const sub = sent.find((s) => s.kind === 'price_submitted');
  return { req, ask, receipt: sub ? renderMessage('price_submitted', sub.data) : '' };
}

const lineAfterClose = (msg) => {
  const lines = msg.split('\n');
  const i = lines.findIndex((x) => x.startsWith('⏰'));
  return i >= 0 ? lines[i + 1] : null;
};
const lineAfterBidClose = (msg) => {
  const lines = msg.split('\n');
  const i = lines.findIndex((x) => x.includes('Bid Close Time'));
  return i >= 0 ? lines[i + 1] : null;
};
const PHONE = 40;

(async () => {
  const cases = [
    ['SuperProcure hard close', load('H1', { softClose: false, closeModelKnown: true, extendSeconds: 0, revisionLimit: 3 }), 'sp',
      '🔒 No extension · 3 bids'],
    ['SuperProcure auto extension, 3 min, 3 times, 30 bids', load('S1', { softClose: true, closeModelKnown: true, extendSeconds: 180, extendCount: 3, revisionLimit: 30 }), 'sp',
      '⏳ Auto extension · +3 min, 3x · 30 bids'],
    ['SuperProcure auto extension with no published increment or cap', load('S2', { softClose: true, closeModelKnown: true, revisionLimit: 30 }), 'sp',
      '⏳ Auto extension · 30 bids'],
    ['SuperProcure close type not published', load('U1', { softClose: false, closeModelKnown: false, revisionLimit: 30 }), 'sp',
      '🔁 30 bids'],
    ['SuperProcure load with no close-type field at all (an old snapshot or a sim load)', load('U2', { revisionLimit: 3 }), 'sp',
      '🔁 3 bids'],
    ['GoComet with the default round cap', load('G1', { softClose: true, closeModelKnown: true }), 'gocomet',
      '⏳ Auto extension · 3 rounds · 3 bids'],
  ];
  let n = 0;
  for (const [name, l, platform, want] of cases) {
    const r = await run(l, platform);
    assert.strictEqual(lineAfterClose(r.ask), want, `${name}: the ask's line under the close time is ${JSON.stringify(lineAfterClose(r.ask))}\n${r.ask}`);
    assert.strictEqual(lineAfterBidClose(r.receipt), want, `${name}: the receipt's line under Bid Close Time is ${JSON.stringify(lineAfterBidClose(r.receipt))}\n${r.receipt}`);
    assert.ok([...want].length <= PHONE, `${name}: ${[...want].length} characters wraps on a phone`);
    ok(++n, `${name}: "${want}" on the ask and the receipt`);
  }

  {
    const r = await run(load('N1', { softClose: false, closeModelKnown: false }), 'sp');
    const after = lineAfterClose(r.ask);
    assert.ok(!after || !/extension|bids/.test(after), `a load with nothing published still got a line: ${JSON.stringify(after)}`);
    ok(++n, 'a load that publishes neither fact gets no line at all');
  }

  {
    const r = await run(load('S3', { softClose: true, closeModelKnown: true, extendSeconds: 180, extendCount: 3, revisionLimit: 30 }), 'sp');
    assert.strictEqual(r.req.load.extendSeconds, 180, `the request snapshot dropped the extension time: ${r.req.load.extendSeconds}`);
    assert.strictEqual(r.req.load.extendCount, 3, `the request snapshot dropped the extension count: ${r.req.load.extendCount}`);
    ok(++n, 'the price request keeps the extension time and count from the load');
  }

  console.log(`\n${pass}/${n} checks passed`);
})().catch((e) => { console.log(`FAIL: ${e.message}`); process.exit(1); });
