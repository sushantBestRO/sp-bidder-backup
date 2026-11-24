'use strict';
/**
 * Endpoint discovery from the app's PUBLIC JavaScript bundles (no auth, read-only).
 * The SPA hardcodes its API base URLs and routes in its built JS. We fetch the
 * app shell, pull the bundle URLs, and mine them for SuperProcure API hosts and
 * /api/ paths - especially anything bidding/auction/load related.
 */
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', '..', 'data', 'recon');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const APP = 'https://app.superprocure.com';

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  return { status: res.status, ct: res.headers.get('content-type') || '', body: await res.text(), url: res.url };
}

function uniq(a) { return [...new Set(a)]; }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('fetching app shell...');
  const shell = await get(APP);
  console.log(`  ${shell.status} ${shell.ct} (final ${shell.url})`);

  // collect candidate bundle URLs from the shell
  const srcs = uniq([
    ...[...shell.body.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]),
    ...[...shell.body.matchAll(/<link[^>]+href=["']([^"']+\.js)["']/gi)].map((m) => m[1]),
    ...[...shell.body.matchAll(/["']([^"']*\/(?:assets|static|js)\/[^"']+\.js)["']/gi)].map((m) => m[1]),
  ]).map((s) => (s.startsWith('http') ? s : APP + (s.startsWith('/') ? s : '/' + s)));
  console.log(`  found ${srcs.length} bundle refs`);

  const hosts = new Set(), paths = new Set(), interesting = new Set();
  const KW = /(bid|auction|enquir|indent|tender|spot|rank|quote|negotiat|award|reverse|vehicle|lane|load|consignment|lot)/i;
  const PATH_RE = /["'`](\/[a-zA-Z][a-zA-Z0-9/_:.?=&{}-]{2,90})["'`]/g;
  const JS_REF_RE = /["'`]([^"'`]*\/[A-Za-z0-9._-]+\.js)["'`]/g;

  // level 1: shell + first-level bundles
  const seen = new Set();
  const bodies = [{ url: APP, body: shell.body }];
  const fetchInto = async (urls, cap) => {
    let n = 0;
    for (let s of urls) {
      if (n >= cap) break;
      if (!s.startsWith('http')) s = APP + (s.startsWith('/') ? s : '/' + s);
      if (!/superprocure\.com/i.test(s) || seen.has(s)) continue;
      seen.add(s); n++;
      try { const r = await get(s); bodies.push({ url: s, body: r.body }); } catch (_) {}
    }
  };
  await fetchInto(srcs, 25);

  // level 2: follow .js chunk references discovered inside the first-level bundles
  const chunkRefs = new Set();
  for (const b of bodies) for (const m of b.body.matchAll(JS_REF_RE)) chunkRefs.add(m[1]);
  await fetchInto([...chunkRefs], 45);
  console.log(`fetched ${bodies.length} files (2 levels); mining...\n`);

  for (const b of bodies) {
    for (const m of b.body.matchAll(/https?:\/\/([a-z0-9.-]*superprocure\.com)/gi)) hosts.add(m[1].toLowerCase());
    for (const m of b.body.matchAll(PATH_RE)) {
      const p = m[1];
      if (/\.(js|css|svg|png|jpe?g|woff2?|ttf|json|map|html)$/i.test(p)) continue; // skip asset paths
      paths.add(p); if (KW.test(p)) interesting.add(p);
    }
    for (const m of b.body.matchAll(/(?:baseURL|baseUrl|API_URL|apiUrl|VITE_[A-Z_]*URL|environment\.[a-zA-Z]*[Uu]rl)["'`:=\s]+["'`](https?:\/\/[^"'`]+)/gi))
      hosts.add(m[1].replace(/https?:\/\//, '').split('/')[0].toLowerCase());
  }

  const report = {
    discoveredAt: new Date().toISOString(),
    hosts: [...hosts].sort(),
    interestingPaths: [...interesting].sort(),
    allApiPaths: [...paths].sort(),
  };
  fs.writeFileSync(path.join(OUT, 'endpoints-from-bundles.json'), JSON.stringify(report, null, 2));

  console.log('=========== SuperProcure hosts referenced in app JS ===========');
  for (const h of report.hosts) console.log('  ' + h);
  console.log('\n=========== BIDDING/AUCTION-related API paths ===========');
  for (const p of report.interestingPaths) console.log('  ' + p);
  console.log(`\n(${report.allApiPaths.length} total /api paths captured -> data/recon/endpoints-from-bundles.json)`);
})().catch((e) => { console.error('discover failed:', e); process.exit(1); });
