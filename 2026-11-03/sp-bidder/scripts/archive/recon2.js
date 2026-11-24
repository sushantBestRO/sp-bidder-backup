'use strict';
/**
 * Authenticated marketplace recon (READ-ONLY). Injects the real session
 * (cookie + localStorage authToken) so the SPA loads, then records the data-API
 * calls and the socket.io live frames. Never submits a quote/bid; a request guard
 * aborts any bid-write. Secrets redacted from disk output; token never printed.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const COOKIE_FILE = process.env.COOKIE_FILE || 'C:\\Users\\sidro\\Downloads\\app.superprocure.com_cookies.txt';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(__dirname, '..', '..', 'data', 'recon');
const RAW = path.join(OUT, 'raw2');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BID_WRITE_RE = /(submit|place|award|revise|accept|confirm|finalize|createTrip|bidVehicle).*(bid|quote|rate|vehicle|trip)|quotePerVehicle|placeBid|bidVehicle/i;

function parseCookies(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const p = line.split('\t'); if (p.length < 7) continue;
    const c = { name: p[5], value: p[6], domain: p[0], path: p[2], secure: p[3] === 'TRUE', httpOnly: false };
    if (Number(p[4]) > 0) c.expires = Number(p[4]);
    out.push(c);
  }
  return out;
}

(async () => {
  fs.mkdirSync(RAW, { recursive: true });
  const cookies = parseCookies(COOKIE_FILE);
  const token = (cookies.find((c) => c.name === 'token') || {}).value;
  const redact = (s) => (typeof s === 'string' && token ? s.split(token).join('[REDACTED]') : s);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1440, height: 900 });

  // seed localStorage for the app origin BEFORE its scripts run -> no SSO bounce
  await page.evaluateOnNewDocument((tok) => {
    if (location.hostname === 'app.superprocure.com') {
      try {
        localStorage.setItem('authToken', tok);
        localStorage.setItem('authHeader', 'Bearer ' + tok);
        localStorage.setItem('signedOut', 'false');
        localStorage.setItem('uid', '32468');
        localStorage.setItem('company', '10686');
        localStorage.setItem('mode', '');
      } catch (e) {}
    }
  }, token);
  await page.setCookie(...cookies);

  const calls = [], aborted = [], ws = [], reqBodies = []; let rawIdx = 0;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const m = req.method(), u = req.url();
    if (WRITE_METHODS.has(m) && /superprocure/i.test(u) && BID_WRITE_RE.test(u)) {
      aborted.push({ method: m, path: u.replace(/https?:\/\/[^/]+/, '') });
      console.log('  [BLOCKED write]', m, u.replace(/https?:\/\/[^/]+/, '')); return req.abort();
    }
    if (m === 'POST' && /superprocure\.com/i.test(u) && ['xhr', 'fetch'].includes(req.resourceType())) {
      const pd = req.postData();
      if (pd) reqBodies.push({ path: u.replace(/https?:\/\/[^/]+/, '').split('?')[0], body: redact(pd).slice(0, 1500) });
    }
    req.continue();
  });
  page.on('response', async (res) => {
    try {
      const req = res.request(), u = res.url();
      if (!/superprocure\.com/i.test(u)) return;
      if (!['xhr', 'fetch'].includes(req.resourceType())) return;
      const ct = res.headers()['content-type'] || '';
      let body = ''; try { if (/json|text/i.test(ct)) body = await res.text(); } catch (_) {}
      let keys = null;
      if (/json/i.test(ct) && body) { try { const j = JSON.parse(body); const d = j && j.data != null ? j.data : j;
        const r = Array.isArray(d) ? (d[0] || {}) : d; keys = (Array.isArray(d) ? ['<array>'] : []).concat(Object.keys(r || {})); } catch (_) {} }
      calls.push({ method: req.method(), host: new URL(u).host, path: u.replace(/https?:\/\/[^/]+/, '').split('?')[0],
        query: u.includes('?') ? '?' + u.split('?')[1].slice(0, 80) : '', status: res.status(), keys });
      if (body) fs.writeFileSync(path.join(RAW, `${String(rawIdx++).padStart(3, '0')}_${req.method()}_${res.status()}.json`), redact(body.slice(0, 200000)));
    } catch (_) {}
  });

  // capture socket.io live frames via CDP
  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', ({ url }) => ws.push({ type: 'open', url: redact(url) }));
  const onFrame = (dir) => ({ response }) => {
    if (ws.filter((f) => f.type === 'frame').length > 60) return;
    const p = response && response.payloadData ? String(response.payloadData).slice(0, 300) : '';
    if (p && !/^\d*(2|3)(probe)?$/.test(p)) ws.push({ type: 'frame', dir, data: redact(p) });
  };
  cdp.on('Network.webSocketFrameReceived', onFrame('recv'));
  cdp.on('Network.webSocketFrameSent', onFrame('sent'));

  console.log('loading marketplace (authenticated)...');
  await page.goto('https://app.superprocure.com/marketplace', { waitUntil: 'networkidle2', timeout: 60000 }).catch((e) => console.log('nav:', e.message));
  await sleep(9000);
  console.log('landed:', page.url(), '| authed:', !/auth\./.test(page.url()));
  console.log('loading loadBoard...');
  await page.goto('https://app.superprocure.com/loadBoard', { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
  await sleep(6000);

  await browser.close();

  const byEp = new Map();
  for (const c of calls) { const k = `${c.method} ${c.path}`; if (!byEp.has(k)) byEp.set(k, { ...c, count: 0 }); const e = byEp.get(k); e.count++; if (!e.keys && c.keys) e.keys = c.keys; }
  const summary = { capturedAt: new Date().toISOString(), authed: !/auth\./.test(page.url()),
    apiHosts: [...new Set(calls.map((c) => c.host))], blockedWriteAttempts: aborted,
    websocket: ws, requestBodies: reqBodies, endpoints: [...byEp.values()] };
  fs.writeFileSync(path.join(OUT, 'summary-auth.json'), JSON.stringify(summary, null, 2));

  console.log('\nREQUEST BODIES (marketplace/board):');
  for (const r of reqBodies.filter((r) => /openMarket|loads\/v4|getLoadCount|getOpenLoadCount/.test(r.path)))
    console.log(`  POST ${r.path}\n    ${r.body}`);

  console.log('\n=============== AUTHENTICATED API CAPTURE ===============');
  console.log('hosts:', summary.apiHosts.join(', '), '| blocked writes:', aborted.length, '| ws frames:', ws.filter(f=>f.type==='frame').length);
  for (const e of summary.endpoints.filter((e) => /superprocure/.test(e.host))) {
    console.log(`  ${e.status}  ${e.method.padEnd(4)} ${e.host}${e.path} ${e.query}`);
    if (e.keys) console.log(`        keys: ${e.keys.slice(0, 18).join(', ')}`);
  }
  if (ws.length) { console.log('\nWEBSOCKET:'); for (const f of ws.slice(0, 20)) console.log('  ', f.type, f.dir || '', (f.url || f.data || '').slice(0, 120)); }
  console.log('\nfull redacted capture -> data/recon/ (summary-auth.json, raw2/)');
})().catch((e) => { console.error('recon2 failed:', e); process.exit(1); });
