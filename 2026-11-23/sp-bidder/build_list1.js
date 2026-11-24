'use strict';
// READ-ONLY. Reads sp-bidder/data/*.json + data/logs/priceRequestArchive-*.jsonl and writes SP_customers_vs_bidder.csv.
// Changes nothing in the project.
// Usage (from the sp-bidder folder):  node build_list.js
//   optional: node build_list.js /path/to/sp-bidder  /path/to/output.csv
const fs = require('fs'), path = require('path');
const ROOT = process.argv[2] || __dirname;
const OUT = process.argv[3] || path.join(process.cwd(), 'SP_customers_vs_bidder.csv');
const { matchCustomer } = require(path.join(ROOT, 'src/model/resolve'));
const rd = (f, dflt) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8')); } catch (e) { console.log(`(${f} not readable)`); return dflt; } };
const customers = Object.values(rd('customers.json', {}));
const accounts = rd('accounts.json', {});
const branches = rd('accountBranches.json', {});
const closed = rd('closedBids.json', {});

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const keyOf = (name) => { const m = matchCustomer(name, customers); return m ? 'B:' + m.label : 'N:' + norm(name); };
const day = (t) => (t ? new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : '');
const notes = {
  'shyam group (kol)': 'Matched via short alias "Shyam" -> Shyam Steel. Verify it is the same company.',
  'bg': 'Matched via alias "BG" -> Borosil. Verify.',
  'demo on prod': 'Looks like a test/demo customer.',
};

// ---- 1. SuperProcure customers (each login's branch list) ----
const sp = new Map();
for (const [accId, doc] of Object.entries(branches)) {
  for (const b of (doc.branches || [])) {
    const n = (b.customer || '').trim(); if (!n) continue;
    if (!sp.has(n)) sp.set(n, { accts: new Set(), branches: 0 });
    const e = sp.get(n); e.branches++; e.accts.add(accId);
  }
}

// ---- 2. Attempts ALLOWED per inquiry (SP's per-load limit, recorded as "revisionLimit") ----
const lim = new Map(); // key -> { names:Set, inq:number, counts:Map(limit->n) }
const L = (k) => { if (!lim.has(k)) lim.set(k, { names: new Set(), inq: 0, counts: new Map() }); return lim.get(k); };
const seenInq = new Set();
function addInquiry(r) {
  if (!r || ((r.platformKey || 'sp') !== 'sp')) return;
  const id = r.id || (r.loadId && r.platformKey + ':' + r.loadId); if (id) { if (seenInq.has(id)) return; seenInq.add(id); }
  const name = (r.companyName || '').trim(); if (!name) return;
  const l = L(keyOf(name)); l.names.add(name); l.inq++;
  const v = Number(r.revisionLimit);
  if (Number.isFinite(v) && v > 0) l.counts.set(v, (l.counts.get(v) || 0) + 1);
}
const logDir = path.join(ROOT, 'data', 'logs');
try {
  for (const f of fs.readdirSync(logDir).filter((f) => /^priceRequestArchive-.*\.jsonl$/.test(f)).sort()) {
    for (const line of fs.readFileSync(path.join(logDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue; try { addInquiry(JSON.parse(line)); } catch (e) { /* skip bad line */ }
    }
  }
} catch (e) { console.log('(price request archive not readable - attempts-allowed will be blank)'); }
const pr = rd('priceRequests.json', {}); for (const r of (Array.isArray(pr) ? pr : Object.values(pr))) addInquiry(r);

// ---- 3. Bids actually placed per customer (SuperProcure records only; GoComet is a different portal) ----
const stats = new Map();
const S = (k) => { if (!stats.has(k)) stats.set(k, { names: new Set(), loads: 0, loadsBid: 0, bids: 0, maxBids: 0, rejected: 0, won: 0, lost: 0, last: 0 }); return stats.get(k); };
let gocomet = 0;
for (const r of Object.values(closed)) {
  if (((r && r.platformKey) || 'sp') !== 'sp') { gocomet++; continue; }
  const s = S(keyOf(r.shipper)); const nb = (r.ourBids || []).length;
  s.names.add((r.shipper || '').trim());
  s.loads++; if (nb) s.loadsBid++;
  s.bids += nb; if (nb > s.maxBids) s.maxBids = nb; s.rejected += (r.rejectedBids || []).length;
  if (r.won === true) s.won++; else if (r.won === false) s.lost++;
  const t = Math.max(r.armedAt || 0, ...(r.ourBids || []).map((b) => b.ts || 0)); if (t > s.last) s.last = t;
}

// ---- 4. Build rows ----
const ZS = { loads: 0, loadsBid: 0, bids: 0, maxBids: 0, rejected: 0, won: 0, lost: 0, last: 0 };
function mostCommon(counts) { let best = null; for (const [v, n] of counts) if (!best || n > best[1] || (n === best[1] && v > best[0])) best = [v, n]; return best; }
function line(name, status, label, k, isOwner, extra) {
  const s = (isOwner && stats.get(k)) || ZS; const l = (isOwner && lim.get(k)) || null;
  const mc = l ? mostCommon(l.counts) : null;
  const all = l ? [...l.counts].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} (${n} inquiries)`).join(', ') : '';
  return [name, status, label, mc ? mc[0] : '', all, l ? l.inq : 0,
    s.loads, s.loadsBid, s.loadsBid ? Math.round((s.bids / s.loadsBid) * 10) / 10 : '', s.maxBids, s.bids, s.rejected, s.bids + s.rejected, s.won, s.lost, day(s.last),
    extra.ids, extra.enabled, extra.branches, extra.note];
}
const owner = new Map();
for (const name of sp.keys()) {
  const m = matchCustomer(name, customers); const k = keyOf(name); const exact = m && norm(m.label) === norm(name);
  if (!owner.has(k) || (exact && !owner.get(k).exact)) owner.set(k, { name, exact });
}
const rows = []; const used = new Set();
for (const [name, e] of sp) {
  const m = matchCustomer(name, customers); const k = keyOf(name); used.add(k);
  const isOwner = owner.get(k).name === name; const ids = [...e.accts].sort();
  let note = notes[name.toLowerCase()] || '';
  if (!isOwner) note = (note ? note + ' ' : '') + `Numbers are counted under "${owner.get(k).name}" (same bidder customer).`;
  rows.push(line(name, m ? 'CONNECTED' : 'NOT CONNECTED', m ? m.label : '', k, isOwner, {
    ids: ids.join(', '), enabled: ids.filter((a) => accounts[a] && accounts[a].enabled !== false).join(', '), branches: e.branches, note }));
}
for (const k of new Set([...stats.keys(), ...lim.keys()])) { // seen in inquiries/bids but not in any login's branch list now
  if (used.has(k)) continue;
  const label = k.startsWith('B:') ? k.slice(2) : '';
  const nm = [...((stats.get(k) || {}).names || []), ...((lim.get(k) || {}).names || [])].find(Boolean) || '(blank company name)';
  rows.push(line(nm, label ? 'CONNECTED' : 'NOT CONNECTED', label, k, true, { ids: '', enabled: '', branches: 0,
    note: 'Has inquiry/bid history but is not in any SP login branch list now.' }));
}
rows.sort((a, b) => (a[1] === b[1] ? (b[12] - a[12]) || (b[5] - a[5]) || a[0].localeCompare(b[0]) : a[1] === 'CONNECTED' ? -1 : 1));

const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
const head = ['Customer on SuperProcure', 'Bidder status', 'Matched bidder customer',
  'Attempts allowed per inquiry (most common)', 'All limits seen', 'Inquiries received',
  'Loads armed', 'Loads with a bid placed', 'Avg bids placed per inquiry', 'Max bids placed on one inquiry',
  'Total bids placed', 'Bids rejected by SP', 'Total bid attempts (placed + rejected)', 'Loads won', 'Loads lost', 'Last bid activity',
  'SP login accounts that see it', 'Enabled accounts', 'Branches', 'Note'];
fs.writeFileSync(OUT, '\uFEFF' + [head, ...rows].map((r) => r.map(q).join(',')).join('\n') + '\n');
const c = rows.filter((r) => r[1] === 'CONNECTED').length;
console.log(`Customers: ${rows.length} | connected: ${c} | not connected: ${rows.length - c}`);
console.log(`Inquiries read: ${seenInq.size} | bid attempts (SP, placed+rejected): ${rows.reduce((a, r) => a + r[12], 0)} | GoComet records skipped: ${gocomet}`);
console.log('Written to:', OUT);
