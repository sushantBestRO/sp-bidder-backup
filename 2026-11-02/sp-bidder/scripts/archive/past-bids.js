'use strict';
// Read-only: dump BRL's actual past bids (amounts) on Syngenta loads, to anchor a
// meaningful bid for a similar lane. node scripts/past-bids.js
const fs = require('fs');
const { RealSuperProcureAdapter } = require('../../src/platform/realAdapter');
const COOKIE = process.env.COOKIE_FILE || 'C:\\Users\\sidro\\Downloads\\app.superprocure.com_cookies.txt';
const token = () => { for (const l of fs.readFileSync(COOKIE, 'utf8').split(/\r?\n/)) { if (l.startsWith('#') || !l.trim()) continue; const p = l.split('\t'); if (p[5] === 'token') return p[6]; } };
const ymd = (d) => d.toISOString().slice(0, 10);
const pts = (s) => { try { return JSON.parse(s).map((p) => p.shortName || p.cityName).join(' -> '); } catch (_) { return s || ''; } };

(async () => {
  const a = new RealSuperProcureAdapter({ token: token() });
  const acct = await a.login();
  const from = new Date(a.serverNow() - 45 * 86400000), to = new Date(a.serverNow() + 10 * 86400000);
  const rows = [];
  let sampleDumped = false;
  for (const tab of ['CONFIRMED', 'HISTORY', 'PENDING']) {
    const body = { baseFilter: { branchIds: acct.branchIds, fromDate: ymd(from), toDate: ymd(to), tab, loadId: null }, limit: { limit: 5000, offset: 0 }, sort: { value: null, order: 'ASC' }, isWeb: 1 };
    const res = await a._post('/sp/loads/v4', body);
    const d = (res.json && (res.json.data || res.json)) || {};
    const bd = d.bidDetails;
    if (!sampleDumped && bd) { console.log('=== bidDetails shape (sample) ===\n' + JSON.stringify(Array.isArray(bd) ? bd.slice(0, 2) : Object.entries(bd).slice(0, 2), null, 1).slice(0, 900) + '\n'); sampleDumped = true; }
    const findBid = (id) => {
      if (!bd) return null;
      if (Array.isArray(bd)) return bd.find((b) => String(b.loadId || b.load || b.id) === String(id));
      return bd[id] || bd[String(id)] || null;
    };
    for (const l of (d.loadDetails || [])) {
      if (!/syngenta/i.test(l.companyName || '')) continue;
      const b = findBid(l.id);
      const amt = b && (b.amount || b.bidAmount || b.lastBid || b.rate || (Array.isArray(b.bids) && b.bids.length && b.bids[b.bids.length - 1].amount));
      rows.push({ tab, lane: pts(l.loadingPoints), wt: l.weight, veh: l.vehicleName || l.vehicleType, amt, code: l.loadCode });
    }
  }
  console.log('=== BRL Syngenta loads: lane | weight | vehicle | OUR bid (if any) ===');
  rows.sort((x, y) => (y.amt || 0) - (x.amt || 0)).forEach((r) => {
    console.log(`  ${r.amt ? ('Rs' + String(r.amt).padStart(7)) : '  (no bid)'}  ${String(r.wt || '?').padStart(3)}MT  ${(r.veh || '').slice(0, 14).padEnd(15)} ${r.lane.padEnd(30)} [${r.code}]`);
  });
  console.log(`\n${rows.length} Syngenta loads, ${rows.filter((r) => r.amt).length} with a captured bid amount.`);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
