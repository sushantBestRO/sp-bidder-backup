'use strict';

const os = require('os');
const fsp = require('fs').promises;
const path = require('path');

/**
 * The one place the daily heartbeat's Server section touches the OS and the filesystem.
 * heartbeat.js stays pure (its header's "touches no filesystem" promise holds) and injects this
 * as `sysProbe`; tests pass a fake with the same read() shape. Every field is read under its own
 * try/catch and degrades to null on failure, so a box where one probe is unavailable (an older
 * Node without fs.statfs, a missing log dir) still reports every OTHER field instead of blanking
 * the whole Server section.
 *
 * This is deliberately NOT app-state persistence - it reads live MACHINE health (free storage,
 * log footprint, memory, uptime) and never writes, so it lives outside the store seam. The store
 * grep-gate (scripts/test-store.js) allows this file by name for exactly that reason: the gate's
 * concern is app STATE going through the store, not a read-only health probe.
 */

// fs.statfs landed in Node 18.15 / 19.6. An older box simply reports no storage figure rather than
// throwing. bavail (blocks free to an UNPRIVILEGED user) is the honest "space you can actually use"
// number - bfree would over-count the root-reserved blocks a non-root app can't touch. usedPct is
// derived from that usable space, matching what `df` shows a human.
async function readStorage(dir) {
  if (typeof fsp.statfs !== 'function') return null;
  const s = await fsp.statfs(dir);
  const total = s.blocks * s.bsize;
  const avail = s.bavail * s.bsize;
  if (!total) return null;
  return { totalBytes: total, availBytes: avail, usedPct: Math.round((1 - avail / total) * 100) };
}

// Sum the app's own PM2 logs. ecosystem.config.cjs writes pm2-out.log and pm2-err.log under
// <cwd>/data/logs; a pm2-logrotate deployment adds dated *.log siblings. Summing every *.log in the
// dir reports the true on-disk footprint even after a rotation. A missing dir (fresh box, logs
// configured elsewhere) throws out of readdir and the caller records null - "no logs to measure",
// distinct from a measured zero - so the renderer skips the fact rather than print a misleading
// "0 MB". (On the standard deploy SP_DATA_DIR is unset, so this dir and the ecosystem out_file dir
// coincide; a box that relocates SP_DATA_DIR while leaving PM2's relative log path is the one case
// this under-reports, and it degrades quietly rather than lying.)
async function readLogsBytes(logsDir) {
  const entries = await fsp.readdir(logsDir);
  let total = 0;
  for (const name of entries) {
    if (!name.endsWith('.log')) continue;
    try { total += (await fsp.stat(path.join(logsDir, name))).size; } catch (_) { /* a file that vanished mid-read is not fatal */ }
  }
  return total;
}

/**
 * Read every Server-section fact in one pass, each field independently fail-soft (null on any
 * error). `dataDir` is the app's data directory (config.dataDir); the PM2 logs sit at
 * <dataDir>/logs on the standard deploy. Returns raw numbers (bytes, percent, seconds); the
 * collector in heartbeat.js owns the thresholds and the human-facing formatting.
 */
async function read({ dataDir } = {}) {
  const base = dataDir || process.cwd();
  const out = { storage: null, logsBytes: null, rssBytes: null, sysFreePct: null, uptimeSec: null };
  try { out.storage = await readStorage(base); } catch (_) { /* older Node / unreadable filesystem */ }
  try { out.logsBytes = await readLogsBytes(path.join(base, 'logs')); } catch (_) { /* no log dir on this box */ }
  try { out.rssBytes = process.memoryUsage().rss; } catch (_) { /* unreadable */ }
  try {
    const tot = os.totalmem();
    out.sysFreePct = tot ? Math.round((os.freemem() / tot) * 100) : null;
  } catch (_) { /* unreadable */ }
  try { out.uptimeSec = process.uptime(); } catch (_) { /* unreadable */ }
  return out;
}

module.exports = { read, readStorage, readLogsBytes };
