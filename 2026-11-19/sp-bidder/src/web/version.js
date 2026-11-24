'use strict';

/**
 * Release-provenance reader: turns the version.json that scripts/deploy.sh stamps into the
 * deploy tarball into the ground-truth "what build is this box running" answer.
 *
 * The deploy pipeline writes version.json at package time (version, tag, git sha, branch,
 * build date, builder host, dirty flag) and ships it at the app root; the running process
 * reads it here at boot. Absent (a dev checkout that never went through deploy.sh) or
 * malformed -> the 'dev' sentinel, NEVER a throw: a missing or corrupt provenance stamp must
 * never be the thing that keeps the bidder from booting and placing bids.
 *
 * The actual file read is delegated to src/store/atomicFile.readTextFile so this module never
 * touches `fs` directly - the store layer stays the single home of filesystem access (the
 * grep gate in scripts/test-store.js). parseVersionInfo is a pure string->object function,
 * so the parsing/normalization can be exercised without any disk at all.
 */

const path = require('path');
const { readTextFile } = require('../store/atomicFile');

// App root = two dirs up from src/web/. version.json lands here in the tarball, so on the box
// it extracts to <app>/version.json alongside package.json.
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');

// The 'dev' fallback for an absent or malformed stamp.
function devInfo(source) {
  return {
    version: 'dev',
    tag: null,
    sha: 'unknown',
    branch: null,
    builtAt: null,
    builderHost: null,
    dirty: false,
    source: source, // 'absent' | 'malformed'
  };
}

function str(v) {
  return typeof v === 'string' && v.length ? v : null;
}

/**
 * Pure: normalize the raw version.json text into a provenance object. Never throws.
 *   null / ''    -> dev sentinel (source: 'absent')
 *   bad JSON     -> dev sentinel (source: 'malformed')
 *   non-object   -> dev sentinel (source: 'malformed')
 *   valid object -> stamped fields, per-field normalized (source: 'file')
 */
function parseVersionInfo(raw) {
  if (raw == null || raw === '') return devInfo('absent');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return devInfo('malformed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return devInfo('malformed');
  }
  // Per-field normalize so a partial or older-shape file still yields a usable object rather
  // than leaking undefined into the banner / the API response.
  return {
    version: str(parsed.version) || 'dev',
    tag: str(parsed.tag),
    sha: str(parsed.sha) || 'unknown',
    branch: str(parsed.branch),
    builtAt: str(parsed.builtAt),
    builderHost: str(parsed.builderHost),
    dirty: parsed.dirty === true,
    source: 'file',
  };
}

/** Read + normalize version.json from rootDir (defaults to the app root). Never throws. */
function loadVersionInfo(rootDir) {
  const file = path.join(rootDir || DEFAULT_ROOT, 'version.json');
  return parseVersionInfo(readTextFile(file));
}

// Short sha for the human-facing banner; the full sha stays in version.json / /api/version.
function shortSha(sha) {
  return typeof sha === 'string' && sha !== 'unknown' && sha.length ? sha.slice(0, 12) : 'unknown';
}

// One-line boot banner: version + sha, so `pm2 logs bid-command` answers "what is live".
function bootBannerLine(info) {
  if (!info || info.source !== 'file') {
    return '[bid-command] version=dev sha=unknown (no version.json - unversioned dev checkout)';
  }
  const extras = [];
  if (info.builtAt) extras.push('built=' + info.builtAt);
  if (info.dirty) extras.push('DIRTY (shipped via DEPLOY_UNSAFE=1)');
  const tail = extras.length ? ' ' + extras.join(' ') : '';
  return '[bid-command] version=' + info.version + ' sha=' + shortSha(info.sha) + tail;
}

module.exports = { loadVersionInfo, parseVersionInfo, bootBannerLine, shortSha };
