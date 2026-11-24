'use strict';
/**
 * TWO CAPTURES RACING ON ONE LOAD: ONE WINS, THE OTHER IS REFUSED, AND THE RECORD IS THE WINNER'S.
 *
 * Regression target: A009. capture() read the request, checked it was awaiting a price, awaited, and
 * then patched it with no compare-and-set. Two captures interleaved there both passed the check and
 * both wrote: the last write owned the record, while engine.arm() hands back the existing monitor for
 * an already-armed load, so the first arm owned the wire. A low cost could bid under a higher cost on
 * record.
 *
 * The interleave is forced, not raced: the store's reads are held at a barrier until both captures
 * have read, so both pass the status check before either writes. Deterministic under MemoryStore.
 *
 *   node scripts/test-capture-compare-and-set.js
 */
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { MemoryStore } = require('../src/store/memoryStore');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

(async () => {
  const store = new MemoryStore();
  const requests = new PriceRequestStore({ store, marginsPct: [9, 5, 1], minMarginPct: 1 });
  const r = await requests.createForLoad({ id: 'CAS-1', lane: { origin: 'Pune', destination: 'Delhi' }, units: 1,
    companyName: 'Acme', closesAt: Date.now() + 3_600_000, startsAt: Date.now() - 60_000, status: 'live' });

  const realGet = store.getDoc.bind(store);
  let waiting = [];
  let barrierOpen = false;
  store.getDoc = async (coll, id) => {
    const doc = await realGet(coll, id);
    if (barrierOpen || coll !== 'priceRequests') return doc;
    await new Promise((resolve) => {
      waiting.push(resolve);
      if (waiting.length === 2) { barrierOpen = true; waiting.forEach((w) => w()); waiting = []; }
    });
    return doc;
  };

  const results = await Promise.allSettled([
    requests.capture(r.id, { cost: 29_000 }),
    requests.capture(r.id, { cost: 41_000 }),
  ]);
  store.getDoc = realGet;

  const won = results.filter((x) => x.status === 'fulfilled');
  const lost = results.filter((x) => x.status === 'rejected');
  ok(won.length === 1, `exactly one capture succeeds (${won.length} did)`);
  // Owner feedback: the loser is its own refusal (CAPTURE_LOST), so the route shows it as an error
  // instead of rendering the page the winner produced.
  ok(lost.length === 1 && lost[0].reason && lost[0].reason.code === 'CAPTURE_LOST',
    `the other is refused as a lost capture (${lost.map((x) => x.reason && `${x.reason.code}: ${x.reason.message}`).join('; ')})`);
  const rec = await requests.getByToken(r.id);
  ok(won.length === 1 && rec.price && rec.price.cost === won[0].value.price.cost,
    `the record holds the winner's cost, the one the route goes on to arm (record ${rec.price && rec.price.cost})`);

  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
