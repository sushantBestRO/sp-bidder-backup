'use strict';
/**
 * Unit test for the release-provenance loader (src/web/version.js). Exercises the loader
 * against fixture directories - present / absent / malformed / partial version.json - and
 * asserts the 'dev' sentinel + never-throws contract that keeps a missing or corrupt stamp
 * from ever blocking boot. Also pins the boot-banner one-liner shape.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadVersionInfo, bootBannerLine, shortSha } = require('../src/web/version');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sp-version-'));
}
function write(dir, contents) {
  fs.writeFileSync(path.join(dir, 'version.json'), contents);
}

const made = [];
function fresh() { const d = tmpDir(); made.push(d); return d; }

try {
  // ---- absent: no version.json (a dev checkout that never deployed) ----
  const a = loadVersionInfo(fresh());
  ok(a.version === 'dev', 'absent -> version "dev"');
  ok(a.sha === 'unknown', 'absent -> sha "unknown"');
  ok(a.tag === null && a.branch === null && a.builtAt === null && a.builderHost === null, 'absent -> null provenance fields');
  ok(a.dirty === false, 'absent -> dirty false');
  ok(a.source === 'absent', 'absent -> source "absent"');

  // ---- malformed: not valid JSON ----
  let mDir = fresh(); write(mDir, '{ this is not: json,,, ');
  let m;
  ok((() => { try { m = loadVersionInfo(mDir); return true; } catch (_) { return false; } })(), 'malformed JSON does not throw');
  ok(m.version === 'dev' && m.source === 'malformed', 'malformed -> version "dev", source "malformed"');

  // ---- malformed: valid JSON but not an object (string / array) ----
  let sDir = fresh(); write(sDir, '"just a string"');
  ok(loadVersionInfo(sDir).source === 'malformed', 'JSON string (non-object) -> source "malformed"');
  let arrDir = fresh(); write(arrDir, '[1,2,3]');
  ok(loadVersionInfo(arrDir).source === 'malformed', 'JSON array (non-object) -> source "malformed"');
  let nullDir = fresh(); write(nullDir, 'null');
  ok(loadVersionInfo(nullDir).version === 'dev', 'JSON null -> version "dev" (no crash)');

  // ---- present + valid: full stamp ----
  let pDir = fresh();
  write(pDir, JSON.stringify({
    version: 'v1.2.0', tag: 'v1.2.0', sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    branch: 'main', builtAt: '2026-07-16T09:30:00Z', builderHost: 'sid-box', dirty: false,
  }));
  const p = loadVersionInfo(pDir);
  ok(p.version === 'v1.2.0' && p.tag === 'v1.2.0', 'valid -> version + tag parsed');
  ok(p.sha === 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', 'valid -> full sha parsed');
  ok(p.branch === 'main' && p.builderHost === 'sid-box', 'valid -> branch + builderHost parsed');
  ok(p.dirty === false && p.source === 'file', 'valid -> dirty false, source "file"');

  // ---- present + dirty (an unsafe DEPLOY_UNSAFE=1 ship) ----
  let dDir = fresh();
  write(dDir, JSON.stringify({ version: 'dev', tag: null, sha: 'deadbeefcafe', dirty: true }));
  const d = loadVersionInfo(dDir);
  ok(d.dirty === true && d.source === 'file', 'dirty stamp -> dirty true, source "file"');
  ok(d.tag === null, 'dirty stamp -> tag null');

  // ---- partial: an older / hand-edited file still yields a usable object ----
  let ptDir = fresh(); write(ptDir, JSON.stringify({ sha: 'abc123' }));
  const pt = loadVersionInfo(ptDir);
  ok(pt.version === 'dev' && pt.sha === 'abc123' && pt.source === 'file', 'partial -> missing version defaults to "dev", present sha kept');
  ok(pt.dirty === false, 'partial -> missing dirty defaults false');

  // ---- default root (no arg) never throws, whatever the repo tree holds ----
  ok((() => { try { const r = loadVersionInfo(); return typeof r.version === 'string'; } catch (_) { return false; } })(), 'loadVersionInfo() with default root never throws');

  // ---- boot banner shape ----
  ok(bootBannerLine(p) === '[bid-command] version=v1.2.0 sha=a1b2c3d4e5f6 built=2026-07-16T09:30:00Z',
    'banner: version + short sha + built for a clean stamp');
  ok(/DIRTY/.test(bootBannerLine(d)), 'banner: dirty stamp carries a DIRTY marker');
  ok(bootBannerLine(a) === '[bid-command] version=dev sha=unknown (no version.json - unversioned dev checkout)',
    'banner: dev sentinel line for an absent stamp');
  ok(shortSha('a1b2c3d4e5f6a7b8') === 'a1b2c3d4e5f6' && shortSha('unknown') === 'unknown', 'shortSha truncates to 12, passes through "unknown"');
} finally {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
