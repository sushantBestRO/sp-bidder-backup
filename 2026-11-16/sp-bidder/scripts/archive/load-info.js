'use strict';
// Read-only: dump one load's economics (ceiling/decrement/weight) + a rate band
// from past Syngenta loads, to pick a meaningful bid. node scripts/load-info.js <id>
const fs = require('fs');
const { RealSuperProcureAdapter } = require('../../src/platform/realAdapter');
const COOKIE = process.env.COOKIE_FILE || 'C:\\Users\\sidro\\Downloads\\app.superprocure.com_cookies.txt';
const token = () => { for (const l of fs.readFileSync(COOKIE, 'utf8').split(/\r?\n/)) { if (l.startsWith('#') || !l.trim()) continue; const p = l.split('\t'); if (p[5] === 'token') return p[6]; } };
const TARGET = process.argv[2] || '22400892';
const ymd = (d) => d.toISOString().slice(0, 10);
const pts = (s) => { try { return JSON.parse(s).map((p) => p.shortName || p.cityName).join(' -> '); } catch (_) { return s || ''; } };

(async () => {
  const a = new RealSuperProcureAdapter({ token: token() });
  const acct = await a.login();
  const from = new Date(a.serverNow() - 45 * 86400000), to = new Date(a.serverNow() + 10 * 86400000);
  let target = null; const band = [];
  for (const tab of ['OPEN', 'PENDING', 'CONFIRMED', 'HISTORY']) {
    const body = { baseFilter: { branchIds: acct.branchIds, fromDate: ymd(from), toDate: ymd(to), tab, loadId: null }, limit: { limit: 5000, offset: 0 }, sort: { value: null, order: 'ASC' }, isWeb: 1 };
    const res = await a._post('/sp/loads/v4', body);
    const d = (res.json && (res.json.data || res.json)) || {};
    for (const l of (d.loadDetails || [])) { if (String(l.id) === TARGET) target = { tab, l }; band.push(l); }
  }
  if (target) {
    const l = target.l;
    console.log(`=== TARGET ${TARGET} (tab ${target.tab}) ===`);
    console.log(JSON.stringify({ code: l.loadCode, company: l.companyName, product: l.productName, lane: pts(l.loadingPoints), vehicle: l.vehicleName || l.vehicleType, weightMT: l.weight, ceilingPrice: l.ceilingPrice, loadMinBid: l.loadMinBid, bidDifference: l.loadBidDifference, bidsAllowed: l.branchBidCountAllowed || l.loadBidCountAllowed, start: l.biddingStartTime, close: l.biddingCloseTime, extend: l.branchAuctionExtendTime }, null, 2));
  } else { console.log(`TARGET ${TARGET} not found in OPEN/PENDING/CONFIRMED/HISTORY`); }
  console.log('\n=== rate band: past Syngenta loads (ceiling | weight | lane | code) ===');
  const seen = new Set();
  band.filter((l) => /syngenta/i.test(l.companyName || '') && l.ceilingPrice).sort((x, y) => (y.ceilingPrice || 0) - (x.ceilingPrice || 0)).forEach((l) => {
    if (seen.has(l.id)) return; seen.add(l.id);
    console.log(`  Rs${String(l.ceilingPrice).padStart(7)}  ${String(l.weight || '?').padStart(3)}MT  ${pts(l.loadingPoints).padEnd(34)} [${l.loadCode}]`);
  });
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
