'use strict';
// Read-only diagnostic: why are no loads "live"? Compares the adapter's server
// clock to the real clock and to each OPEN-tab load's [start, close] window.
const fs = require('fs');
const { RealSuperProcureAdapter } = require('../../src/platform/realAdapter');
const COOKIE_FILE = process.env.COOKIE_FILE || 'C:\\Users\\sidro\\Downloads\\app.superprocure.com_cookies.txt';
const token = () => { for (const l of fs.readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/)) { if (l.startsWith('#') || !l.trim()) continue; const p = l.split('\t'); if (p[5] === 'token') return p[6]; } };
const ist = (ms) => ms == null ? '   --   ' : new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const mins = (ms) => (ms / 60000).toFixed(1) + 'm';

(async () => {
  const a = new RealSuperProcureAdapter({ token: token() });
  const acct = await a.login();
  const sys = Date.now();
  const srv = a.serverNow();
  console.log(`offset (serverTimeOffsetMs): ${a.serverTimeOffsetMs} ms  (${mins(a.serverTimeOffsetMs)})`);
  console.log(`system clock : ${ist(sys)} IST`);
  console.log(`server clock : ${ist(srv)} IST   <- adapter uses THIS for live/scheduled`);
  console.log('');

  const loads = await a.listAuctions();
  console.log(`${loads.length} loads in OPEN tab. for each: window [start..close], status by SERVER clock vs REAL clock\n`);
  const realStatus = (l) => (l.closesAt && sys >= l.closesAt) ? 'closed' : (l.startsAt && sys >= l.startsAt) ? 'LIVE' : 'sched';
  let mismatch = 0, realLive = 0;
  for (const l of loads) {
    const rs = realStatus(l);
    if (rs === 'LIVE') realLive++;
    const flag = rs.toLowerCase() !== l.status ? '  <<< MISMATCH' : '';
    if (flag) mismatch++;
    console.log(`  ${l.loadCode || l.id}  ${(l.companyName || '').slice(0, 18).padEnd(19)} start ${ist(l.startsAt)} close ${ist(l.closesAt)}  adapter=${l.status.padEnd(9)} real=${rs}${flag}`);
  }
  console.log(`\nadapter-live: ${loads.filter((l) => l.status === 'live').length} | real-clock-live: ${realLive} | mismatches: ${mismatch}`);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
