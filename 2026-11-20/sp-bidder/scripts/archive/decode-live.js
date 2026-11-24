'use strict';
// Decode a live-capture file: socket.io event names/shapes + v4 bidDetails.
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', '..', 'data', 'recon', 'live');
const file = process.argv[2] || path.join(DIR, fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().pop());
const log = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log('file:', path.basename(file), '| authed:', log.authed, '| ws events:', log.ws.length, '| api:', log.api.length, '| aborted:', log.aborted.length);

// ---- socket.io frames ----
const frames = log.ws.filter((f) => f.type === 'frame');
const evCounts = {}; const samples = {};
for (const f of frames) {
  const d = f.data || '';
  const m = d.match(/^(\d+)(.*)$/s); if (!m) continue;
  const code = m[1], rest = m[2];
  if (code !== '42' && code !== '40' && code !== '0') continue; // 42=event,40=connect,0=open
  if (code !== '42') continue;
  let name = '?';
  try { const arr = JSON.parse(rest); name = Array.isArray(arr) ? String(arr[0]) : '?';
    if (!samples[name]) samples[name] = { dir: f.dir, payload: JSON.stringify(arr.slice(1)).slice(0, 400) };
  } catch (_) { name = rest.slice(0, 40); }
  evCounts[name] = (evCounts[name] || 0) + 1;
}
console.log('\n=== socket.io EVENTS (name x count) ===');
for (const [n, c] of Object.entries(evCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(4)}  ${n}`);
console.log('\n=== event sample payloads ===');
for (const [n, s] of Object.entries(samples)) console.log(`  [${s.dir}] ${n}: ${s.payload}`);

// ---- API: v4 bidDetails during the live window ----
console.log('\n=== v4 / openMarket bidDetails during the window ===');
let shown = 0;
for (const a of log.api) {
  if (!/loads\/v4|openMarket/.test(a.path) || !a.body) continue;
  try {
    const d = JSON.parse(a.body); const dd = d.data || d;
    const bd = dd.bidDetails;
    if (Array.isArray(bd) && bd.length && shown < 2) {
      console.log(`  ${new Date(a.at).toISOString().slice(11, 19)} ${a.path}  bidDetails[${bd.length}] keys: ${Object.keys(bd[0]).join(',')}`);
      console.log('    sample:', JSON.stringify(bd[0]).slice(0, 500));
      shown++;
    }
    const ld = dd.loadDetails;
    if (Array.isArray(ld) && ld[0] && shown < 3) {
      const l = ld.find((x) => x.isOpenAuction) || ld[0];
      console.log(`  load ${l.loadCode} isOpenAuction=${l.isOpenAuction} status=${l.loadStatusKey} latestOfferRate=${l.latestOfferRate} biddingClose=${l.biddingCloseTime}`);
    }
  } catch (_) {}
}
if (!shown) console.log('  (no populated bidDetails captured)');
