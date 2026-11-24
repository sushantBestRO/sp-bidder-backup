'use strict';
/**
 * Read-only auction-timing analysis. Queries the load board across tabs over a
 * wide date window and reports WHEN auctions run, by shipper + weekday + hour
 * (IST) - so we can time the demo to a live Syngenta window. No bids.
 */
const fs = require('fs');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

const COOKIE_FILE = process.env.COOKIE_FILE || 'C:\\Users\\sidro\\Downloads\\app.superprocure.com_cookies.txt';
const token = () => { for (const l of fs.readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/)) { if (l.startsWith('#') || !l.trim()) continue; const p = l.split('\t'); if (p[5] === 'token') return p[6]; } };
const ymd = (d) => d.toISOString().slice(0, 10);
const istParts = (iso) => {
  const d = new Date(iso);
  const wd = d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
  const hm = d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  const day = d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
  return { wd, hm, hour: hm.slice(0, 2), day };
};

(async () => {
  const a = new RealSuperProcureAdapter({ token: token() });
  const acct = await a.login();
  const branchIds = acct.branchIds;
  const from = new Date(a.serverNow() - 35 * 86400000);
  const to = new Date(a.serverNow() + 10 * 86400000);

  const byId = new Map();
  for (const tab of ['OPEN', 'PENDING', 'CONFIRMED', 'HISTORY']) {
    const body = { baseFilter: { branchIds, fromDate: ymd(from), toDate: ymd(to), tab, loadId: null },
      limit: { limit: 5000, offset: 0 }, sort: { value: null, order: 'ASC' }, isWeb: 1 };
    const res = await a._post('/sp/loads/v4', body);
    const d = (res.json && (res.json.data || res.json)) || {};
    const loads = Array.isArray(d.loadDetails) ? d.loadDetails : [];
    let withStart = 0;
    for (const l of loads) { if (l.biddingStartTime) { byId.set(l.id, l); withStart++; } }
    console.log(`tab ${tab.padEnd(9)} -> ${loads.length} loads, ${withStart} with an auction start`);
  }

  const loads = [...byId.values()].filter((l) => l.biddingStartTime);
  console.log(`\ntotal distinct auction loads (last 35d + next 10d): ${loads.length}\n`);

  const shippers = {};
  for (const l of loads) {
    const name = (l.companyName || 'unknown').replace(/\s*\(.*/, '').trim();
    const key = /syngenta/i.test(name) ? 'Syngenta' : /renewsys/i.test(name) ? 'Renewsys' : /mahindra/i.test(name) ? 'Mahindra' : name;
    (shippers[key] = shippers[key] || []).push(l);
  }

  for (const [name, ls] of Object.entries(shippers).sort((a, b) => b[1].length - a[1].length)) {
    const wd = {}, hr = {};
    for (const l of ls) { const p = istParts(l.biddingStartTime); wd[p.wd] = (wd[p.wd] || 0) + 1; hr[p.hour] = (hr[p.hour] || 0) + 1; }
    const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const wdStr = order.map((d) => `${d} ${wd[d] || 0}`).join(' | ');
    const hrStr = Object.entries(hr).sort().map(([h, c]) => `${h}:00 x${c}`).join('  ');
    console.log(`### ${name}  (${ls.length} auctions)`);
    console.log(`   weekday: ${wdStr}`);
    console.log(`   start hour (IST): ${hrStr}`);
    if (/syngenta/i.test(name)) {
      console.log('   recent Syngenta auction times:');
      ls.sort((x, y) => x.biddingStartTime.localeCompare(y.biddingStartTime)).slice(-12).forEach((l) => {
        const p = istParts(l.biddingStartTime); console.log(`     ${p.day} ${p.wd} ${p.hm} IST  ${l.loadCode} ${l.companyName}`);
      });
    }
    console.log('');
  }
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
