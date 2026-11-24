'use strict';
/**
 * A RESTART DOES NOT RE-POST "Login logged out" FOR AN ACCOUNT THAT WAS ALREADY DOWN, even after the
 * notifier's sent-mark for that message has been evicted.
 *
 * test-boot-auth-episode.js pins that the boot alert for an ongoing outage reuses the episode's dedupe
 * key, and proves "no duplicate" against a notifSent store holding that key. On the box the key does
 * not survive: notifSent keeps the newest 1,000 marks and ordinary traffic turns it over in about a
 * day. At the v2.16.0 restart every account that was already down got a second "Login logged out".
 *
 * Two real boot() runs in two child processes over one file-backed data dir, because a restart is two
 * processes and nothing in between may be hand-crafted:
 *   phase 1  the account fails login at boot -> the desk is told once. A day of ordinary traffic then
 *            evicts that message's sent-mark.
 *   phase 2  the process restarts with the account still down -> nothing new reaches the desk.
 * Control: a second down account whose phase-1 message never reached anybody is offered again at the
 * restart - only a delivered message is spent.
 *
 *   node scripts/test-boot-auth-no-repost-after-mark-eviction.js
 */
const fs = require('fs'); // allowed: test harness (temp dirs + subprocess), not app state
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PHASE = process.env.BOOT_REPOST_PHASE;

if (!PHASE) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spbootrepost-'));
  const run = (phase) => {
    const r = spawnSync(process.execPath, [__filename], {
      env: Object.assign({}, process.env, { BOOT_REPOST_PHASE: phase, BOOT_REPOST_ROOT: root, LOG_LEVEL: 'silent' }),
      encoding: 'utf8', timeout: 120_000,
    });
    const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('RESULT '));
    if (!line) {
      console.log(`FAIL - harness: phase ${phase} printed no RESULT (exit ${r.status})\n${r.stdout}\n${r.stderr}`);
      process.exit(1);
    }
    return JSON.parse(line.slice(7));
  };
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
  try {
    const one = run('1');
    ok(one.bootOk, `phase 1 boots with one healthy account (${one.bootError || 'ok'})`);
    ok(one.authDeadSends === 1, `phase 1: the down account's "Login logged out" reaches the desk once (got ${one.authDeadSends})`);
    ok(one.markEvicted, 'phase 1: a day of ordinary traffic evicts that message\'s sent-mark, as on the box');
    const two = run('2');
    ok(two.bootOk, `phase 2 boots with one healthy account (${two.bootError || 'ok'})`);
    ok(one.undeliveredSends === 0, 'phase 1: the control account message did not reach anybody');
    ok(two.authDeadSends === 0,
      `phase 2: a restart with the account still down re-posts nothing (got ${two.authDeadSends} "Login logged out" send(s))`);
    ok(two.undeliveredSends === 1,
      `phase 2: the control account's undelivered message is offered again (got ${two.undeliveredSends})`);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ---- child: one real boot() ----
const ROOT = process.env.BOOT_REPOST_ROOT;
const APP_DIR = path.join(ROOT, 'app');
const DESK_DIR = path.join(ROOT, 'desk');
fs.mkdirSync(APP_DIR, { recursive: true });
fs.mkdirSync(DESK_DIR, { recursive: true });
process.env.PLATFORM = 'real';
process.env.STORE_BACKEND = 'file';
process.env.PORT = '0';
process.env.SP_ADMIN_PASS_HASH = 'test-hash';
process.env.SP_SESSION_SECRET = 'test-session-secret';
process.env.SP_DATA_DIR = APP_DIR;
delete process.env.SP_DEMO_SEED;
process.env.SP_TOKEN = 'good-token';
process.env.SP_TOKEN_3 = 'undelivered-token';
process.env.SP_TOKEN_2 = 'h.' + Buffer.from(JSON.stringify({ exp: Math.floor((Date.now() + 30 * 86_400_000) / 1000), u_id: 'u2' }))
  .toString('base64') + '.s';

(async () => {
  const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
  RealSuperProcureAdapter.prototype.login = async function () {
    if (this.token !== 'good-token') { const e = new Error('auth_failed_401'); e.code = 'AUTH'; throw e; }
    this.account = { carrierId: 9001, branchIds: [1], isCarrier: true, company: 'Test Co', user: 'Test User',
      userId: 'u1', tokenExp: Date.now() + 365 * 86_400_000, serverTimeOffsetMs: 0 };
    return this.account;
  };
  RealSuperProcureAdapter.prototype.connectSocket = async function () { return null; };
  RealSuperProcureAdapter.prototype.listAuctions = async function () { return []; };

  const { WhatsAppClient } = require('../src/notify/whatsapp');
  const { Notifier, DEDUPE_CAP } = require('../src/notify/notifier');
  const { createStore } = require('../src/store');
  const srv = require('../src/web/server');

  if (PHASE === '1') {
    await srv.store.putDoc('accounts', 'healthy', { accountId: 'healthy', label: 'Healthy', tokenEnv: 'SP_TOKEN', enabled: true, createdAt: 1 });
    await srv.store.putDoc('accounts', 'down', { accountId: 'down', label: 'Down Account', tokenEnv: 'SP_TOKEN_2', enabled: true, createdAt: 2 });
    await srv.store.putDoc('accounts', 'undelivered', { accountId: 'undelivered', label: 'Undelivered Account', tokenEnv: 'SP_TOKEN_3', enabled: true, createdAt: 3 });
  }

  // The real delivery stack, over a file store both phases share, so "reached the desk" is counted.
  const sends = [];
  const transport = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (PHASE === '1' && /Undelivered Account/.test(String(body.message || ''))) throw new Error('simulated: send failed');
    sends.push(body);
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) };
  };
  const deskStore = createStore({ backend: 'file', dataDir: DESK_DIR });
  const desk = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {},
    wa: new WhatsAppClient({ enabled: true, transport, token: 't', productId: 'p', phoneId: '128023' }),
    store: deskStore, recipientsProvider: async () => ([{ name: 'Desk', phone: '+919000000001', alerts: ['error'] }]),
    healthProvider: async () => true });
  const inFlight = [];
  srv.notifier.alert = (kind, payload, opts) => { const p = desk.alert(kind, payload, opts); inFlight.push(p); return p; };
  srv.notifier.wasDelivered = (key) => desk.wasDelivered(key);

  const out = { bootOk: false, bootError: null, authDeadSends: 0, undeliveredSends: 0, markEvicted: null };
  let server = null;
  try { server = await srv.boot(); out.bootOk = true; } catch (e) { out.bootError = e.message; }
  for (let i = 0; i < 20 && inFlight.length; i++) { await Promise.all(inFlight.splice(0)); await new Promise((r) => setTimeout(r, 25)); }
  const loggedOut = (label) => sends.filter((s) => /Login logged out/.test(String(s.message || ''))
    && String(s.message || '').includes(label)).length;
  out.authDeadSends = loggedOut('Down Account');
  out.undeliveredSends = loggedOut('Undelivered Account');

  if (PHASE === '1') {
    const file = path.join(DESK_DIR, 'notifSent.json');
    const marks = JSON.parse(fs.readFileSync(file, 'utf8'));
    const t0 = Date.now();
    for (let i = 0; i < DEDUPE_CAP; i++) marks[`filler_${i}`] = { key: `filler_${i}`, kind: 'won', at: t0 + 1 + i };
    fs.writeFileSync(file, JSON.stringify(marks));
    await desk._markSent('filler_last', 'won');
    const left = await deskStore.listDocs('notifSent');
    out.markEvicted = !left.some((d) => d && /^sp_auth_dead_down_/.test(d.key));
  }

  for (const s of srv.stacks) { try { s.discovery.stop(); } catch (_) {} }
  if (server) server.close();
  console.log('RESULT ' + JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.log('RESULT ' + JSON.stringify({ bootOk: false, bootError: 'crash: ' + ((e && e.stack) || e) })); process.exit(0); });
