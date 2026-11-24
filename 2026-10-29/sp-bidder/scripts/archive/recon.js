'use strict';
/**
 * SuperProcure API recon (READ-ONLY).
 *
 * Loads the real account in headless Chrome using the exported cookies, navigates
 * read-only, and records the API calls the app makes so we can map the endpoints
 * needed for the real adapter (list loads / read rank+countdown / place bid).
 *
 * SAFETY:
 *  - Never clicks a submit/bid control.
 *  - Belt-and-suspenders: a request guard ABORTS any write-method request that
 *    looks like a bid submission and logs the endpoint instead of letting it fire.
 *  - Secrets (the JWT, cookie values) are redacted from everything written to disk.
 *  - Full captures go to data/recon/ (gitignored).
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const COOKIE_FILE = process.env.COOKIE_FILE || 'C:\\Users\\sidro\\Downloads\\app.superprocure.com_cookies.txt';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'https://app.superprocure.com';
const OUT = path.join(__dirname, '..', '..', 'data', 'recon');
const RAW = path.join(OUT, 'raw');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// write-requests that look like placing/altering a bid -> abort, never send
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BID_WRITE_RE = /(submit|place|award|revise|accept|confirm|finalize|save|update|create).*(bid|quote|rate|offer|tender)|(bid|quote|rate|offer|tender).*(submit|place|award|revise|accept|confirm|finalize)/i;

function parseCookies(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const out = [];
  for (let line of txt.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const p = line.split('\t');
    if (p.length < 7) continue;
    const [domain, , cpath, secure, expiry, name, value] = p;
    const c = { name, value, domain, path: cpath, secure: secure === 'TRUE', httpOnly: false };
    const e = Number(expiry);
    if (e > 0) c.expires = e;
    out.push(c);
  }
  return out;
}

function redactor(secrets) {
  const list = secrets.filter(Boolean);
  return (s) => {
    if (typeof s !== 'string') return s;
    let r = s;
    for (const sec of list) if (sec && sec.length > 6) r = r.split(sec).join('[REDACTED]');
    return r;
  };
}

async function main() {
  fs.mkdirSync(RAW, { recursive: true });
  const cookies = parseCookies(COOKIE_FILE);
  const redact = redactor(cookies.map((c) => c.value));
  console.log(`loaded ${cookies.length} cookies; auth cookie present: ${cookies.some((c) => c.name === 'token')}`);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1440, height: 900 });

  const calls = [];      // captured API calls
  const aborted = [];    // blocked write attempts
  let rawIdx = 0;

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const m = req.method();
    const u = req.url();
    if (WRITE_METHODS.has(m) && /superprocure/i.test(u) && BID_WRITE_RE.test(u)) {
      aborted.push({ method: m, url: u.replace(/https?:\/\/[^/]+/, '') });
      console.log(`  [BLOCKED write] ${m} ${u.replace(/https?:\/\/[^/]+/, '')}`);
      return req.abort();
    }
    req.continue();
  });

  page.on('response', async (res) => {
    try {
      const req = res.request();
      const u = res.url();
      if (!/superprocure/i.test(u)) return;
      const rt = req.resourceType();
      if (!['xhr', 'fetch'].includes(rt)) return;
      const ct = (res.headers()['content-type'] || '');
      let bodyText = '';
      try { if (/json|text/i.test(ct)) bodyText = await res.text(); } catch (_) {}
      let topKeys = null, sample = null;
      if (/json/i.test(ct) && bodyText) {
        try {
          const j = JSON.parse(bodyText);
          const root = Array.isArray(j) ? (j[0] || {}) : j;
          topKeys = Array.isArray(j) ? ['<array>', ...Object.keys(root || {})] : Object.keys(root || {});
          sample = redact(JSON.stringify(j).slice(0, 60));
        } catch (_) {}
      }
      const pathOnly = u.replace(/https?:\/\/[^/]+/, '');
      calls.push({ method: req.method(), host: new URL(u).host, path: pathOnly, status: res.status(),
        contentType: ct.split(';')[0], topKeys });
      if (bodyText) {
        fs.writeFileSync(path.join(RAW, `${String(rawIdx++).padStart(3, '0')}_${req.method()}_${res.status()}.json`),
          redact(bodyText.slice(0, 200000)));
      }
    } catch (_) {}
  });

  // 1) establish origin (unauth), 2) set cookies, 3) reload authenticated
  console.log('navigating (unauth) to establish origin...');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.setCookie(...cookies);
  console.log('cookies set; reloading authenticated...');
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 45000 }).catch((e) => console.log('nav note:', e.message));
  await sleep(8000);

  const landed = page.url();
  const title = await page.title().catch(() => '');
  const authed = !/login|signin|sign-in/i.test(landed);
  console.log(`landed: ${landed}  title: "${title}"  looksAuthenticated: ${authed}`);

  // discover read-only in-app routes from anchors, visit a few that look like loads/bids
  let routes = [];
  try {
    routes = await page.$$eval('a[href]', (els) => els.map((e) => e.getAttribute('href')).filter(Boolean));
  } catch (_) {}
  const readRe = /(bid|auction|load|indent|enquir|tender|spot|trip|order|dashboard|home)/i;
  const skipRe = /(create|new|add|submit|place|award|edit|delete|logout)/i;
  const visit = [...new Set(routes)].filter((h) => readRe.test(h) && !skipRe.test(h)).slice(0, 6);
  console.log(`discovered ${routes.length} links; visiting ${visit.length} read-only routes...`);
  for (const h of visit) {
    const url = h.startsWith('http') ? h : BASE + (h.startsWith('/') ? h : '/' + h);
    if (!/superprocure/i.test(url)) continue;
    console.log('  -> ' + url.replace(BASE, ''));
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await sleep(4000);
  }

  await browser.close();

  // ---- summarize ----
  const byEndpoint = new Map();
  for (const c of calls) {
    const key = `${c.method} ${c.path.split('?')[0]}`;
    if (!byEndpoint.has(key)) byEndpoint.set(key, { ...c, count: 0, sampleKeys: c.topKeys });
    const e = byEndpoint.get(key); e.count++; if (!e.sampleKeys && c.topKeys) e.sampleKeys = c.topKeys;
  }
  const summary = {
    capturedAt: new Date().toISOString(),
    landed, title, looksAuthenticated: authed,
    apiHosts: [...new Set(calls.map((c) => c.host))],
    blockedWriteAttempts: aborted,
    endpoints: [...byEndpoint.values()].map((e) => ({
      method: e.method, host: e.host, path: e.path.split('?')[0], status: e.status,
      contentType: e.contentType, count: e.count, responseTopKeys: e.sampleKeys })),
  };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n================ DISCOVERED API (read-only) ================');
  console.log(`auth: looksAuthenticated=${authed}  hosts=${summary.apiHosts.join(', ')}`);
  console.log(`blocked write attempts: ${aborted.length}`);
  console.log('endpoints:');
  for (const e of summary.endpoints) {
    console.log(`  ${e.status}  ${e.method.padEnd(4)} ${e.host}${e.path}`);
    if (e.responseTopKeys) console.log(`        keys: ${e.responseTopKeys.slice(0, 16).join(', ')}`);
  }
  console.log('\nfull (redacted) capture in data/recon/  | summary in data/recon/summary.json');
}
main().catch((e) => { console.error('recon failed:', e); process.exit(1); });
