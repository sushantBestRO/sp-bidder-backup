'use strict';
/* Dev-only: seed the console with sample data so every base panel renders populated
   in mock mode (discovery/logging only produce data in real mode / a running demo).
   Seeds: price requests (Price Requests), closed bids (History), admin config (Targets +
   Settings), and the model (Team + Customers + Assignments) that alert routing derives from.
   For Live Bids, also run the server with SP_DEMO_SEED=1 (arms long sim auctions).

   `node scripts/seed-worklist-demo.js`         -> seed price requests + closed bids + config + model
   `node scripts/seed-worklist-demo.js --clear` -> remove all seeded data */
const path = require('path');
const config = require('../src/config');
const { createStore } = require('../src/store');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { COLLECTION: CLOSED } = require('../src/logging/bidLogger');
const { COLLECTION: CONFIG_COLL, KEY: CONFIG_KEY } = require('../src/admin/configStore');
const { CustomerStore, COLLECTION: CUSTOMERS } = require('../src/model/customerStore');
const { PersonStore, COLLECTION: PEOPLE } = require('../src/model/personStore');
const { AssignmentStore, COLLECTION: ASSIGNMENTS } = require('../src/model/assignmentStore');

const store = createStore({ dataDir: config.dataDir, logDir: path.join(config.dataDir, 'logs'), backend: config.storeBackend });
const reqs = new PriceRequestStore({ store, marginsPct: config.marginsPct, minMarginPct: config.minMarginPct });
const scheduler = new DurableScheduler(config.intentsFile);
const customers = new CustomerStore({ store });
const people = new PersonStore({ store });
const assignments = new AssignmentStore({ store, people, customers });

(async () => {
  // reset everything this script owns (incl. scheduler intents, so a fresh demo boot
  // doesn't rehydrate phantom auctions from a prior SP_DEMO_SEED run)
  for (const r of await reqs.listAll()) await store.removeDoc('priceRequests', r.id);
  for (const c of await store.listDocs(CLOSED)) await store.removeDoc(CLOSED, c.auctionId);
  for (const it of scheduler.all()) scheduler.remove(it.auctionId);
  await store.removeDoc(CONFIG_COLL, CONFIG_KEY);
  for (const a of await assignments.list()) await store.removeDoc(ASSIGNMENTS, a.assignmentId);
  for (const p of await people.list()) await store.removeDoc(PEOPLE, p.personId);
  for (const c of await customers.list()) await store.removeDoc(CUSTOMERS, c.customerId);

  if (process.argv.includes('--clear')) { console.log('cleared price requests, closed bids, config, and model'); return; }

  const now = Date.now();

  // ---- price requests (Price Requests panel) ----
  // City -> "State PIN" for the pickup/drop addresses below, so the /price/<token> card's
  // pincode sub-labels render the same way a real /sp/loads/v4 load would (server.js's
  // renderLoadCard falls back to the bare lane header when a load carries no points).
  const CITY_TAIL = {
    Khopoli: 'Maharashtra 410203', Keeranur: 'Tamil Nadu 622502', Giddarbaha: 'Punjab 152101',
    Mulug: 'Telangana 506343', Vellore: 'Tamil Nadu 632004',
  };
  const mk = (id, o, d, shipper, equip, units, closesMin, soft) => ({
    id, lane: { origin: o, destination: d }, equipment: equip, units, companyName: shipper,
    shipmentType: 'FTL', closesAt: now + closesMin * 60000, startsAt: now - 60000,
    ceiling: 120000, revisionLimit: 3, softClose: soft, status: 'live',
    points: [
      { kind: 'pickup', address: `${o}, ${CITY_TAIL[o]}, India` },
      { kind: 'drop', address: `${d}, ${CITY_TAIL[d]}, India` },
    ],
  });
  await reqs.createForLoad(mk('22586146', 'Khopoli', 'Keeranur', 'Renewsys India', "Trailer 40'", 16, 9, false), { deadlineAt: now + 7 * 60000 });
  const b = await reqs.createForLoad(mk('22587198', 'Khopoli', 'Giddarbaha', 'Renewsys India', "Trailer 40'", 5, 19, false), { deadlineAt: now + 17 * 60000 });
  await reqs.capture(b.id, { cost: 85000 });
  await reqs.createForLoad(mk('22530067', 'Mulug', 'Vellore', 'Mahindra Agri Solutions', 'Open Body', 1, 5, true), { deadlineAt: now - 1000 });
  await reqs.expireOverdue(now);

  // ---- closed bids (History panel) ----
  const mkClosed = (id, o, d, shipper, equip, units, cost, finalRank, won, closeModel, hoursAgo) => {
    const closedAt = now - hoursAgo * 3600000;
    const open = Math.round(cost * 1.126);
    const last = Math.round(cost * (won ? 1.072 : 1.063));
    return {
      auctionId: id, lane: { origin: o, destination: d }, equipment: equip, units, shipper,
      cost, floor: Math.round(cost * 1.063), ladder: [open, Math.round(cost * 1.072), Math.round(cost * 1.063)],
      ourBids: [
        { price: open, rungIndex: 0, rank: 3, ts: closedAt - 9 * 60000, dryRun: false },
        { price: last, rungIndex: won ? 1 : 2, rank: won ? 1 : 2, ts: closedAt - 2000, latencyMs: 240, dryRun: false },
      ],
      lastBidPrice: last, finalRank, won, closeModel, closedAt, status: 'closed',
    };
  };
  const closed = [
    mkClosed('22510011', 'Khopoli', 'Keeranur', 'Syngenta', "Trailer 40'", 1, 78000, 1, true, 'hard', 3),
    mkClosed('22510044', 'Khopoli', 'Giddarbaha', 'Syngenta', "Trailer 40'", 1, 91000, 2, false, 'hard', 6),
    mkClosed('22509920', 'Dahej', 'Hyderabad', 'Syngenta', 'Open Body', 1, 64000, 1, true, 'hard', 9),
    mkClosed('22509810', 'Mulug', 'Vellore', 'Renewsys India', "Trailer 40'", 2, 120000, 1, true, 'hard', 22),
    mkClosed('22509777', 'Bharuch', 'Nagpur', 'Syngenta', 'Open Body', 1, 54000, 3, false, 'hard', 27),
    mkClosed('22509600', 'Ankleshwar', 'Indore', 'Renewsys India', "Trailer 32'", 1, 47000, 1, true, 'hard', 31),
    mkClosed('22509540', 'Khopoli', 'Salem', 'Syngenta', "Trailer 40'", 1, 88000, 2, false, 'hard', 49),
    mkClosed('22509410', 'Dahej', 'Pune', 'Syngenta', 'Open Body', 1, 39000, 1, true, 'soft', 54),
  ];
  for (const c of closed) await store.putDoc(CLOSED, c.auctionId, c);

  // ---- admin config (Targets + Settings) ----
  await store.putDoc(CONFIG_COLL, CONFIG_KEY, {
    marginsPct: config.marginsPct.slice(),
    minMarginPct: config.minMarginPct,
    allowlist: { shippers: ['Syngenta'], lanes: [], hardCloseOnly: true },
    discoveryIntervalMs: config.discoveryIntervalMs,
    priceDeadlineLeadMs: config.priceDeadlineLeadMs,
    notifyMode: 'whatsapp',
  });

  // ---- model (Team + Customers + Assignments - what alert routing now derives from) ----
  const syngenta = await customers.upsert({ label: 'Syngenta', aliases: ['Syngenta India'] });
  const suyashh = await people.upsert({ name: 'Suyashh', phone: '9000000001', alertPrefs: ['won', 'lost', 'error'], alertAll: true });
  const pricingDesk = await people.upsert({ name: 'Pricing desk', phone: '9000000002', alertPrefs: [], alertAll: false });
  await assignments.upsert({ personId: pricingDesk.personId, customerId: syngenta.customerId, alertKinds: ['price_needed', 'outbid'] });

  const all = await reqs.listAll();
  console.log('price requests:', all.map((r) => `${r.loadId}:${r.status}`).join(', '));
  console.log('closed bids:', closed.length, `(won ${closed.filter((c) => c.won).length})`);
  console.log('config: allowlist=Syngenta');
  console.log(`model: 1 customer (${syngenta.label}), 2 people (${suyashh.name} - every load, ${pricingDesk.name} - scoped via assignment)`);
  console.log('capture page (awaiting): /price/' + all.find((r) => r.status === 'awaiting_price').id);
  console.log('for Live Bids, start the server with: SP_DEMO_SEED=1 npm start');
})().catch((e) => { console.error(e); process.exit(1); });
