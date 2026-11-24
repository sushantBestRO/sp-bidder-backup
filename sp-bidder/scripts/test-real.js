'use strict';
// Read-only validation of RealSuperProcureAdapter against the live API.
// Reads the token from the cookies file, logs in, lists auctions. No bids.
const fs = require('fs');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

const COOKIE_FILE = process.env.COOKIE_FILE || 'C:\\Users\\sidro\\Downloads\\app.superprocure.com_cookies.txt';
function token() {
  for (const line of fs.readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('#') || !line.trim()) continue;
    const p = line.split('\t'); if (p[5] === 'token') return p[6];
  }
}

(async () => {
  const a = new RealSuperProcureAdapter({ token: token() });
  const acct = await a.login();
  console.log('connected. carrierId=%s  branches=%d  company=%s  user=%s',
    acct.carrierId, acct.branchIds.length, acct.company, acct.user);
  console.log('server-time offset: %dms   token expires: %s',
    acct.serverTimeOffsetMs, new Date(acct.tokenExp).toISOString().slice(0, 10));

  const loads = await a.listAuctions();
  console.log('\n%d auction load(s):\n', loads.length);
  for (const l of loads) {
    const mins = l.closesAt ? Math.round((l.closesAt - a.serverNow()) / 60000) : null;
    console.log(`  [${l.status}] ${l.loadCode}  ${l.lane.origin} -> ${l.lane.destination}`);
    console.log(`     ${l.equipment} x${l.units} | ${l.shipmentType} | ${l.companyName} | ${l.productName || ''}`);
    console.log(`     decrement Rs${l.minDecrement} | revisions ${l.revisionLimit} | showL1Rate ${l.showL1Rate} | soft ${l.softClose}`);
    console.log(`     starts ${l.biddingStartTime} | closes ${l.biddingCloseTime} (${mins != null ? mins + ' min away' : '-'})`);
  }
  process.exit(0);
})().catch((e) => { console.error('test-real failed:', e.message); process.exit(1); });
