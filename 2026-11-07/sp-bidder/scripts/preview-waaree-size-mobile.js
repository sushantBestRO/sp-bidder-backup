'use strict';

// Local fixture for the reported two-type Waaree form; never boots discovery or sends a bid.
const path = require('path');
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_DATA_DIR = path.resolve(__dirname, '../docs/tests/2026-10-05_waaree-size-mobile/runtime');
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const { app, requests, stacks } = require('../src/web/server');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { readLoadSpec } = require('../src/platform/gocometCargo');
const { renderMessage } = require('../src/notify/waTemplates');
const { Notifier } = require('../src/notify/notifier');

(async () => {
  const accountId = 'gocomet-preview';
  const adapter = new GoCometAdapter({ token: null, bidEnabled: true });
  adapter.writeEnabled = false;
  stacks.push({ account: { accountId, label: 'GoComet' }, platformKey: 'gocomet', adapter,
    engine: { caps: adapter.capabilities(), snapshot: () => [], planPreview: () => ({ ladder: [], floor: 0, rungCount: 0 }) } });
  const descriptors = [
    `1 x 40FT (LxWXH - 40'x8'x9'6") 25 Ton Truck`,
    `1 x 40FT (LxWXH - 40'x8'x9'6") Truck`,
  ];
  const spec = readLoadSpec({ quantity: descriptors, mode: 'FTL' }, null);
  const load = {
    id: '261005CK4T', platformKey: 'gocomet', account: { accountId, label: 'GoComet' },
    ...spec, equipment: spec.cargoTypes.map(t => `${t.count} x ${t.label}`).join(', '),
    units: 2, cargoLines: 2, quoteType: 'TRUCK', companyName: 'Waaree',
    lane: { origin: 'Survey No. 1934, NH-48, Near Darshan Hotel, Village # Degam, Taluka # Chikhli, Degam-396530, Gujarat',
      destination: 'M/S SRI DURGA MALLESWARI EDUCATIONAL SOCIETY NRI Institute of Technology, Pothavarapadu, Agiripalli Mandal Krishna-521212, Andhra Pradesh' },
    distanceKm: 1209, startsAt: Date.now() - 60_000, closesAt: Date.now() + 120 * 60_000,
    status: 'open',
  };
  const r = await requests.createForLoad(load, { deadlineAt: load.closesAt - 120_000, platformKey: 'gocomet' });
  const n = new Notifier({ mode: 'dashboard', baseUrl: 'http://127.0.0.1:4399' });
  console.log(renderMessage('price_needed', await n._priceNeededData(r)));
  const single = await requests.createForLoad({ ...load, id: 'SINGLE-PREVIEW',
    ...readLoadSpec({ quantity: [descriptors[0]], mode: 'FTL' }, null),
    equipment: '40 ft, 25 T', units: 1, cargoLines: 1 },
  { deadlineAt: load.closesAt - 120_000, platformKey: 'gocomet' });
  const pmt = await requests.createForLoad({ ...load, id: 'PMT-PREVIEW', cargoTypes: null,
    equipment: '40 ft', units: 25, quoteType: 'PMT', cargoLines: 1 },
  { deadlineAt: load.closesAt - 120_000, platformKey: 'gocomet' });
  console.log(`SINGLE ${n.link(single)}\nPMT ${n.link(pmt)}`);
  const sp = new RealSuperProcureAdapter({ token: null });
  sp.writeEnabled = false;
  const spAccount = { accountId: 'sp-preview', label: 'SuperProcure' };
  stacks.push({ account: spAccount, platformKey: 'sp', adapter: sp,
    engine: { caps: sp.capabilities(), snapshot: () => [], planPreview: () => ({ ladder: [], floor: 0, rungCount: 0 }) } });
  const spLoad = sp._mapLoad({ id: 'SP-SIZE-PREVIEW', vehicleName: '15 MT Turbo -22Ft',
    vehicleType: 1, vehicleCount: 1, weight: 12, brancheUnit: 'MT', branchQuoteType: 'FTL',
    companyName: 'SuperProcure fixture', dimensions: '78:40:78', loadDimensionUnit: null,
    biddingOn: 1, biddingStartTime: new Date(Date.now() - 60_000).toISOString(),
    biddingCloseTime: new Date(load.closesAt).toISOString(), branchAuctionExtendTime: '00:00:00',
    loadingPoints: JSON.stringify([{ isLoadingPoint: 1, shortName: 'Surat' }, { isLoadingPoint: 0, shortName: 'Pune' }]) },
  { loads: { id: 'SP-SIZE-PREVIEW' }, loadReference: {
    infoToShow: [{ title: 'Dimensions', value: '7.8 x 4 x 7.8 ft' }] } });
  const spRequest = await requests.createForLoad({ ...spLoad, account: spAccount },
    { deadlineAt: load.closesAt - 120_000, platformKey: 'sp' });
  console.log(`SP ${n.link(spRequest)}`);
  app.listen(4399, '127.0.0.1', () => console.log(`PREVIEW ${n.link(r)}`));
})().catch(e => { console.error(e); process.exit(1); });
