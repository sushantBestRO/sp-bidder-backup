'use strict';
/**
 * Token-validity probe (READ-ONLY GET). Tests whether the exported `token`
 * authenticates SuperProcure API calls directly (which is all the bot needs),
 * independent of the SPA UI. No writes. Token never printed.
 */
const fs = require('fs');
const COOKIE_FILE = process.env.COOKIE_FILE || 'C:\\Users\\sidro\\Downloads\\app.superprocure.com_cookies.txt';

function token() {
  for (const line of fs.readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('#') || !line.trim()) continue;
    const p = line.split('\t');
    if (p[5] === 'token') return p[6];
  }
  return null;
}
const T = token();
if (!T) { console.error('no token cookie found'); process.exit(1); }

// candidate read endpoints (guesses) across likely hosts
const HOSTS = ['auth-api.superprocure.com', 'api.superprocure.com', 'app-api.superprocure.com', 'sp-api.superprocure.com'];
const PATHS = [
  '/api/v1/config/countries', '/api/v1/user', '/api/v1/users/me', '/api/v1/me',
  '/api/v1/profile', '/api/v1/user/profile', '/api/v1/auth/me', '/api/v1/auth/verify',
  '/api/v1/session', '/api/v1/carrier', '/api/v1/dashboard', '/api/v1/health',
];

async function hit(url, withAuth) {
  const headers = { 'user-agent': 'Mozilla/5.0', accept: 'application/json' };
  if (withAuth) { headers.cookie = 'token=' + T; headers.authorization = 'Bearer ' + T; }
  try {
    const res = await fetch(url, { method: 'GET', headers, redirect: 'manual' });
    let keys = '';
    const ct = res.headers.get('content-type') || '';
    if (/json/i.test(ct)) {
      try { const j = await res.json(); const r = Array.isArray(j) ? (j[0] || {}) : j;
        keys = (Array.isArray(j) ? '[array] ' : '') + Object.keys(r || {}).slice(0, 12).join(','); } catch (_) {}
    }
    return { status: res.status, loc: res.headers.get('location') ? '(redirect)' : '', ct: ct.split(';')[0], keys };
  } catch (e) { return { status: 'ERR', err: e.code || e.message }; }
}

(async () => {
  console.log('probing token validity (read-only)...\n');
  // baseline DNS / host reachability + one unauth vs auth comparison
  for (const host of HOSTS) {
    let reachable = false;
    for (const p of PATHS) {
      const url = `https://${host}${p}`;
      const r = await hit(url, true);
      if (r.status === 'ERR' && (r.err === 'ENOTFOUND' || r.err === 'getaddrinfo ENOTFOUND')) { reachable = false; break; }
      reachable = true;
      const tag = r.status === 200 ? 'OK ' : '   ';
      console.log(`${tag}${String(r.status).padEnd(6)} GET ${host}${p}  ${r.ct || ''} ${r.loc || ''} ${r.keys ? '{' + r.keys + '}' : ''}`);
    }
    if (!reachable) console.log(`(host not resolvable: ${host})`);
    console.log('');
  }
  // unauth vs auth on the one host we KNOW resolves, to see if auth changes anything
  console.log('auth vs no-auth on auth-api /config/countries (is it gated?):');
  const a = await hit('https://auth-api.superprocure.com/api/v1/config/countries', true);
  const u = await hit('https://auth-api.superprocure.com/api/v1/config/countries', false);
  console.log(`  with token: ${a.status}   without token: ${u.status}`);
})();
