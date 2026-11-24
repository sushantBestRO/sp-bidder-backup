'use strict';
// READ-ONLY. Reads sp-bidder/data/*.json and writes SP_customers_vs_bidder.csv. Changes nothing in the project.
// Usage (from the sp-bidder folder):  node build_list.js
//   optional: node build_list.js /path/to/sp-bidder  /path/to/output.csv
const fs = require('fs'), path = require('path');
const ROOT = process.argv[2] || __dirname;
const OUT = process.argv[3] || path.join(process.cwd(), 'SP_customers_vs_bidder.csv');
const { matchCustomer } = require(path.join(ROOT, 'src/model/resolve'));
const rd = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
const customers = Object.values(rd('customers.json'));
const accounts = rd('accounts.json');
const branches = rd('accountBranches.json');
let closed = {};
try { closed = rd('closedBids.json'); } catch (e) { console.log('closedBids.json not readable - bid columns will be 0'); }

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// One key per real-world customer: the bidder customer if it matches, else the normalised name.
const keyOf = (name) => { const m = matchCustomer(name, customers); return m ? 'B:' + m.label : 'N:' + norm(name); };

const notes = {
  'shyam group (kol)': 'Matched via short alias "Shyam" -> Shyam Steel. Verify it is the same company.',
  'bg': 'Matched via alias "BG" -> Borosil. Verify.',
  'demo on prod': 'Looks like a test/demo customer.',
};

// ---- SuperProcure customers (from each login's branch list) ----
const sp = new Map();
for (const [accId, doc] of Object.entries(branches)) {
  for (const b of (doc.branches || [])) {
    const n = (b.customer || '').trim(); if (!n) continue;
    if (!sp.has(n)) sp.set(n, { accts: new Set(), branches: 0 });
    const e = sp.get(n); e.branches++; e.accts.add(accId);
  }
}

// ---- Bid attempts per customer (SuperProcure records only; GoComet is a different portal) ----
const stats = new Map();
const S = (k) => { if (!stats.has(k)) stats.set(k, { names: new Set(), loads: 0, loadsBid: 0, bids: 0, rejected: 0, won: 0, lost: 0, last: 0 }); return stats.get(k); };
let gocomet = 0;
for (const r of Object.values(closed)) {
  if (((r && r.platformKey) || 'sp') !== 'sp') { gocomet++; continue; }
  const s = S(keyOf(r.shipper));
  const nb = (r.ourBids || []).length;
  s.names.add((r.shipper || '').trim());
  s.loads++; if (nb) s.loadsBid++;
  s.bids += nb; s.rejected += (r.rejectedBids || []).length;
  if (r.won === true) s.won++; else if (r.won === false) s.lost++;
  const t = Math.max(r.armedAt || 0, ...(r.ourBids || []).map((b) => b.ts || 0));
  if (t > s.last) s.last = t;
}
const day = (t) => (t ? new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : '');

const rows = []; const used = new Set();
// If several SP names resolve to the same bidder customer, show the bids once (on the best-named row).
const owner = new Map();
for (const name of sp.keys()) {
  const m = matchCustomer(name, customers); const k = keyOf(name);
  const exact = m && norm(m.label) === norm(name);
  if (!owner.has(k) || (exact && !owner.get(k).exact)) owner.set(k, { name, exact });
}
const ZERO = { loads: 0, loadsBid: 0, bids: 0, rejected: 0, won: 0, lost: 0, last: 0 };
for (const [name, e] of sp) {
  const m = matchCustomer(name, customers);
  const k = keyOf(name); used.add(k);
  const isOwner = owner.get(k).name === name;
  const s = (isOwner && stats.get(k)) || ZERO;
  const ids = [...e.accts].sort();
  let note = notes[name.toLowerCase()] || '';
  if (!isOwner) note = (note ? note + ' ' : '') + `Bid numbers are counted under "${owner.get(k).name}" (same bidder customer).`;
  rows.push([name, m ? 'CONNECTED' : 'NOT CONNECTED', m ? m.label : '', ids.join(', '),
    ids.filter((a) => accounts[a] && accounts[a].enabled !== false).join(', '), e.branches,
    s.loads, s.loadsBid, s.bids, s.rejected, s.bids + s.rejected, s.won, s.lost, day(s.last), note]);
}
// customers we bid for that are not in any login's branch list right now - keep them so no bids are lost
for (const [k, s] of stats) {
  if (used.has(k)) continue;
  const label = k.startsWith('B:') ? k.slice(2) : '';
  const nm = [...s.names].find(Boolean) || '(blank shipper name)';
  rows.push([nm, label ? 'CONNECTED' : 'NOT CONNECTED', label, '', '', 0,
    s.loads, s.loadsBid, s.bids, s.rejected, s.bids + s.rejected, s.won, s.lost, day(s.last),
    'Has bid history but is not in any SP login branch list now.']);
}
rows.sort((a, b) => (a[1] === b[1] ? b[10] - a[10] || a[0].localeCompare(b[0]) : a[1] === 'CONNECTED' ? -1 : 1));

const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
const head = ['Customer on SuperProcure', 'Bidder status', 'Matched bidder customer', 'SP login accounts that see it', 'Enabled accounts', 'Branches',
  'Loads armed', 'Loads with a bid placed', 'Bids placed', 'Bids rejected by SP', 'Total bid attempts (placed + rejected)', 'Loads won', 'Loads lost', 'Last bid activity', 'Note'];
fs.writeFileSync(OUT, '\uFEFF' + [head, ...rows].map((r) => r.map(q).join(',')).join('\n') + '\n');
const c = rows.filter((r) => r[1] === 'CONNECTED').length;
console.log(`Customers: ${rows.length} | connected: ${c} | not connected: ${rows.length - c}`);
console.log(`Total bid attempts (SuperProcure, placed + rejected): ${rows.reduce((a, r) => a + r[10], 0)} | GoComet records skipped: ${gocomet}`);
console.log('Written to:', OUT);
