'use strict';

/**
 * rtt-benchmark.js - measure the latency that actually decides hard-close snipes:
 * the round-trip path to SuperProcure, from whatever host this runs on.
 *
 * WHY: GCP is not automatically faster than the current VPS for a sniper. What wins
 * a buzzer auction is the round-trip to api.superprocure.com at the instant of the
 * bid write (realAdapter records this as `lastWriteRttMs`). Before any host/region
 * move we must PROVE a candidate is closer on this path - p50 AND the tail - not
 * assume "cloud = better". Run this SAME script unchanged from each candidate host
 * (vps, gcp-asia-south1, gcp-asia-south2, a local baseline), label each run, and
 * compare in docs/rtt-benchmark/RESULTS.md.
 *
 * SAFETY: this NEVER places a bid. It only times TCP connect, TLS handshake (cold +
 * warm), and a non-mutating read. The write endpoint (/sp/bids/createV2) is never
 * called. The authenticated read is opt-in (SP_TOKEN) and hits getAvailableViews only.
 *
 * Node 18+, no new deps (built-in net/tls/https/perf_hooks).
 *
 * Usage:
 *   RTT_HOST_LABEL=vps node scripts/rtt-benchmark.js
 *   RTT_HOST_LABEL=gcp-asia-south1 RTT_SAMPLES=200 node scripts/rtt-benchmark.js
 *   RTT_HOST_LABEL=vps SP_TOKEN=eyJ... node scripts/rtt-benchmark.js   # authed read path
 *
 * Output: a stats table, a ready-to-paste RESULTS.md markdown row block, and a JSON
 * blob - all to stdout. Copy the markdown rows into docs/rtt-benchmark/RESULTS.md.
 */

const net = require('net');
const tls = require('tls');
const https = require('https');
const { performance } = require('perf_hooks');

const HOST = 'api.superprocure.com';
const PORT = 443;
const LABEL = process.env.RTT_HOST_LABEL || 'unlabelled';
const SAMPLES = Number(process.env.RTT_SAMPLES || 100);
const TOKEN = process.env.SP_TOKEN || null;
const READ_PATH = '/sp/base/getAvailableViews?isWeb=1'; // cheap, non-mutating login read
const UA = 'rtt-benchmark/1.0';

// hard guard: this tool must never touch the write path
const FORBIDDEN = '/sp/bids';

function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function stats(samples) {
  const ok = samples.filter((x) => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b);
  const fails = samples.length - ok.length;
  const failPct = samples.length ? (100 * fails) / samples.length : 0;
  if (!ok.length) return { n: samples.length, failPct, empty: true };
  const mean = ok.reduce((a, b) => a + b, 0) / ok.length;
  const variance = ok.reduce((a, b) => a + (b - mean) * (b - mean), 0) / ok.length;
  return {
    n: samples.length,
    min: ok[0],
    p50: pct(ok, 50),
    p90: pct(ok, 90),
    p95: pct(ok, 95),
    p99: pct(ok, 99),
    max: ok[ok.length - 1],
    stddev: Math.sqrt(variance),
    failPct,
  };
}

function timeTcpConnect() {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const sock = net.connect({ host: HOST, port: PORT });
    sock.once('connect', () => { const dt = performance.now() - t0; sock.destroy(); resolve(dt); });
    sock.once('error', () => { sock.destroy(); resolve(null); });
    sock.setTimeout(10000, () => { sock.destroy(); resolve(null); });
  });
}

function timeTlsHandshake(session) {
  // returns { dt, session } - pass the returned session back in to measure a WARM (resumed) handshake
  return new Promise((resolve) => {
    const t0 = performance.now();
    const sock = tls.connect({ host: HOST, port: PORT, servername: HOST, session: session || undefined }, () => {
      const dt = performance.now() - t0;
      const s = sock.getSession();
      sock.destroy();
      resolve({ dt, session: s });
    });
    sock.once('error', () => { sock.destroy(); resolve({ dt: null, session }); });
    sock.setTimeout(10000, () => { sock.destroy(); resolve({ dt: null, session }); });
  });
}

function timeHttpRead() {
  return new Promise((resolve) => {
    if (READ_PATH.startsWith(FORBIDDEN)) { resolve(null); return; } // belt-and-suspenders
    const headers = { 'user-agent': UA, accept: 'application/json' };
    const method = TOKEN ? 'GET' : 'HEAD';
    const path = TOKEN ? READ_PATH : '/';
    if (TOKEN) headers.authorization = 'Bearer ' + TOKEN;
    const t0 = performance.now();
    const req = https.request({ host: HOST, port: PORT, method, path, headers }, (res) => {
      res.on('data', () => {}); // drain
      res.on('end', () => resolve(performance.now() - t0));
    });
    req.once('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function collect(label, fn, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await fn());
  return { label, samples: out };
}

async function collectTls(n) {
  const cold = [];
  const warm = [];
  let session = null;
  for (let i = 0; i < n; i++) {
    const c = await timeTlsHandshake(null);       // cold: no resumption
    cold.push(c.dt);
    if (c.session) session = c.session;
    const w = await timeTlsHandshake(session);    // warm: resume the captured session
    warm.push(w.dt);
    if (w.session) session = w.session;
  }
  return { cold, warm };
}

function fmt(x) { return x == null ? '-' : x.toFixed(1); }

function tableRow(metric, s) {
  if (s.empty) return `${metric.padEnd(12)} | all ${s.n} samples FAILED`;
  return [
    metric.padEnd(12),
    fmt(s.min), fmt(s.p50), fmt(s.p90), fmt(s.p95), fmt(s.p99), fmt(s.max),
    fmt(s.stddev), s.failPct.toFixed(0) + '%',
  ].join(' | ');
}

function mdRow(date, tod, metric, s) {
  const g = (k) => (s.empty ? '' : fmt(s[k]));
  return `| ${date} | ${tod} | ${LABEL} | ${s.n} | ${metric} | ${g('min')} | ${g('p50')} | ${g('p90')} | ${g('p95')} | ${g('p99')} | ${g('max')} | ${g('stddev')} | ${s.failPct.toFixed(0)}% | |`;
}

async function main() {
  const startedAt = new Date(); // normal script (not a workflow) - Date is fine here
  const date = startedAt.toISOString().slice(0, 10);
  const tod = startedAt.toISOString().slice(11, 16) + ' UTC';

  console.log(`RTT benchmark -> ${HOST}:${PORT}`);
  console.log(`host label: ${LABEL} | samples: ${SAMPLES} | authed read: ${TOKEN ? 'yes' : 'no (HEAD /)'}`);
  console.log('measuring (never touches the write path)...\n');

  const tcp = await collect('tcp_connect', timeTcpConnect, SAMPLES);
  const tlsRes = await collectTls(SAMPLES);
  const http = await collect('http_read', timeHttpRead, SAMPLES);

  const results = {
    tcp_connect: stats(tcp.samples),
    tls_cold: stats(tlsRes.cold),
    tls_warm: stats(tlsRes.warm),
    http_read: stats(http.samples),
  };

  console.log('metric       | min | p50 | p90 | p95 | p99 | max | stddev | fail%');
  console.log('-------------|-----|-----|-----|-----|-----|-----|--------|------');
  for (const [m, s] of Object.entries(results)) console.log(tableRow(m, s));

  console.log('\n--- paste into docs/rtt-benchmark/RESULTS.md ---');
  for (const [m, s] of Object.entries(results)) console.log(mdRow(date, tod, m, s));

  console.log('\n--- JSON ---');
  console.log(JSON.stringify({ host: LABEL, target: HOST, startedAt: startedAt.toISOString(), samples: SAMPLES, authedRead: !!TOKEN, results }, null, 2));
}

main().catch((e) => { console.error('benchmark error:', e && e.message); process.exit(1); });
