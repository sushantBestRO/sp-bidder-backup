'use strict';
/**
 * GREP GATE: no browser-level dialogs in operator-facing surfaces.
 *
 * alert() / confirm() / prompt() block the whole tab, cannot be styled or themed, render
 * differently per browser, and on a live-money console they look like a phishing popup
 * rather than part of Bid Command. The console has an in-app replacement
 * (dashboard/src/components/ui/notices.tsx: notify + confirm), so a native call reappearing
 * is a regression, not a shortcut.
 *
 * Two scopes:
 *   A. dashboard/src/**            - the React console. Zero tolerance.
 *   B. src/web/server.js           - the server-rendered /price, /track and reprice pages.
 *      Their client JS lives inside template literals, so this scans the emitted-script
 *      side only. ALLOWLIST below carries the one known remaining call plus why.
 *
 *   node scripts/test-no-native-dialogs.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const repoRoot = path.join(__dirname, '..');

// A native call, not a property/method that merely ends in the same letters. The leading
// (?<![\w$.]) rules out notifier.alert(...), this.confirm(...), someAlert(...), and the word
// sitting inside a longer identifier.
//
// alert/prompt have no same-named in-app API (the replacement is notify()), so any bare call
// is native. `confirm` is the one collision: useNotices() destructures an in-app confirm() with
// the same name, so a BARE confirm( is judged by where the identifier comes from, while an
// explicit window.confirm( is always native.
const NATIVE_ALERT_PROMPT = /(?<![\w$.])(?:window\s*\.\s*)?(?:alert|prompt)\s*\(/;
const WINDOW_CONFIRM = /(?<![\w$.])window\s*\.\s*confirm\s*\(/;
const BARE_CONFIRM = /(?<![\w$.])confirm\s*\(/;
// Files that legitimately own a local `confirm` identifier: anything pulling it off the hook,
// plus the notices module that defines it.
const OWNS_INAPP_CONFIRM = /useNotices\s*\(\s*\)|from\s+['"][^'"]*ui\/notices['"]|NoticesProvider/;

/** Comment-only lines - prose about alert()/confirm() is not a call. */
const isCommentLine = (s) => /^(\/\/|\/\*|\*)/.test(s.trim());

/**
 * Lines whose native call is deliberate + accounted for, keyed by file with the reason.
 * Currently EMPTY - both surfaces are fully converted. The machinery stays because the next
 * native call should have to justify itself in writing here rather than just be added.
 */
const ALLOWLIST = {};

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '.git') continue;
      walk(p, out);
      continue;
    }
    if (/\.(ts|tsx|js|jsx)$/.test(ent.name)) out.push(p);
  }
  return out;
}

function scan(absFile) {
  const rel = path.relative(repoRoot, absFile).split(path.sep).join('/');
  const allowed = ALLOWLIST[rel] || [];
  const body = fs.readFileSync(absFile, 'utf8');
  const inAppConfirm = OWNS_INAPP_CONFIRM.test(body);
  const hits = [];
  body.split(/\r?\n/).forEach((line, i) => {
    if (isCommentLine(line)) return;
    const native =
      NATIVE_ALERT_PROMPT.test(line) ||
      WINDOW_CONFIRM.test(line) ||
      (BARE_CONFIRM.test(line) && !inAppConfirm);
    if (!native) return;
    if (allowed.some((a) => line.includes(a.match))) return;
    hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
  return hits;
}

(async () => {
  // ---- A. the React console: zero native dialogs ----
  const consoleRoot = path.join(repoRoot, 'dashboard', 'src');
  const consoleHits = walk(consoleRoot).flatMap(scan);
  assert.deepStrictEqual(
    consoleHits, [],
    'no alert()/confirm()/prompt() in dashboard/src - use useNotices() from components/ui/notices.tsx instead.\n  ' + consoleHits.join('\n  '),
  );
  ok('grep gate: no native dialogs in dashboard/src');

  // ---- B. server-rendered pages: only the allowlisted call ----
  const serverFile = path.join(repoRoot, 'src', 'web', 'server.js');
  const serverHits = scan(serverFile);
  assert.deepStrictEqual(
    serverHits, [],
    'unexpected native dialog in src/web/server.js client JS - add an in-app dialog, or allowlist it with a reason.\n  ' + serverHits.join('\n  '),
  );
  ok('grep gate: no unallowlisted native dialogs in src/web/server.js');

  // ---- C. the allowlist itself stays honest: a stale entry must fail loudly ----
  // Without this, an allowlist entry silently outlives the call it excused and the gate
  // quietly weakens over time.
  for (const [rel, entries] of Object.entries(ALLOWLIST)) {
    const body = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    for (const e of entries) {
      assert.ok(
        body.includes(e.match),
        `stale allowlist entry for ${rel}: "${e.match}" no longer exists - delete it from ALLOWLIST in ${path.basename(__filename)}`,
      );
    }
  }
  ok('allowlist has no stale entries');

  // ---- D. the replacement actually exists (the gate is only fair if there is an out) ----
  const notices = path.join(repoRoot, 'dashboard', 'src', 'components', 'ui', 'notices.tsx');
  assert.ok(fs.existsSync(notices), 'dashboard/src/components/ui/notices.tsx must exist as the in-app replacement');
  const noticesBody = fs.readFileSync(notices, 'utf8');
  assert.ok(/export function NoticesProvider/.test(noticesBody), 'notices.tsx exports NoticesProvider');
  assert.ok(/export function useNotices/.test(noticesBody), 'notices.tsx exports useNotices');
  ok('in-app replacement (NoticesProvider + useNotices) is present');

  console.log(`\n${pass}/4 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
