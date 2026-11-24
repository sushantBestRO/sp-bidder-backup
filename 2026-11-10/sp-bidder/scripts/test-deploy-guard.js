'use strict';
/**
 * Shell-level test for the deploy pre-flight guard (scripts/deploy-guard.sh). Sources the
 * guard in a real POSIX sh and exercises its two decision functions against fixture git repos:
 *   deploy_preflight_guard - refuse (exit 1) a non-main / dirty / unpushed tree; allow (exit 0)
 *     a clean synced main; allow with DEPLOY_UNSAFE=1 (result "override").
 *   deploy_next_version    - v1.0.0 when there is no tag yet; correct patch/minor/major bumps.
 *
 * Needs `sh` and `git` to be spawnable. Where they are not (e.g. `npm test` run from a bare
 * PowerShell with no Git-Bash sh on PATH), the test SKIPS cleanly (exit 0) rather than failing,
 * and DEPLOY.md documents the manual steps. It runs for real under Git Bash and on Linux CI.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Windows paths -> forward slashes; Git Bash sh and native git both accept "C:/foo/bar".
const fwd = (p) => p.replace(/\\/g, '/');
const GUARD = fwd(path.join(__dirname, 'deploy-guard.sh'));

function shOk() {
  const r = spawnSync('sh', ['-c', 'exit 0'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}
function gitOk() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

if (!shOk() || !gitOk()) {
  console.log('SKIP - sh and/or git not spawnable here; guard logic is covered under Git Bash / CI.');
  console.log('\n0 passed, 0 failed (skipped)');
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
function mkRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['-c', 'init.defaultBranch=main', 'init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Guard Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
}
function commit(dir, file, msg) {
  fs.writeFileSync(path.join(dir, file), 'x\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', msg], dir);
}

// Run one guard/next-version call inside a sourced sh. Returns { rc, result, stdout }.
function runGuard(dirFwd, extraEnv) {
  const script = `. "${GUARD}"; rc=0; deploy_preflight_guard "${dirFwd}" >/dev/null 2>&1 || rc=$?; echo "RC=$rc GUARD=\${DEPLOY_GUARD_RESULT:-none}"`;
  const r = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: Object.assign({}, process.env, extraEnv || {}) });
  const m = /RC=(\d+) GUARD=(\S+)/.exec(r.stdout || '');
  return m ? { rc: Number(m[1]), result: m[2] } : { rc: -1, result: 'parse-error', stdout: r.stdout, stderr: r.stderr };
}
function nextVersion(dirFwd, bump) {
  const r = spawnSync('sh', ['-c', `. "${GUARD}"; deploy_next_version "${dirFwd}" ${bump}`], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-guard-'));
try {
  // ---- fixture: clean main synced to a bare origin ----
  const origin = path.join(root, 'origin.git');
  git(['-c', 'init.defaultBranch=main', 'init', '--bare', '-q', origin], root);
  const work = path.join(root, 'work');
  mkRepo(work);
  commit(work, 'file.txt', 'init');
  git(['remote', 'add', 'origin', fwd(origin)], work);
  git(['push', '-q', '-u', 'origin', 'main'], work);
  const workFwd = fwd(work);

  // (a) clean synced main -> allow, result "clean"
  let g = runGuard(workFwd);
  ok(g.rc === 0 && g.result === 'clean', `clean synced main -> allow (got rc=${g.rc} result=${g.result})`);

  // (b) non-main branch -> refuse
  git(['checkout', '-q', '-b', 'feat/held-work'], work);
  g = runGuard(workFwd);
  ok(g.rc === 1, `feature branch -> refuse (got rc=${g.rc})`);
  git(['checkout', '-q', 'main'], work);

  // (c) dirty tree (untracked file that would ship in the tarball) -> refuse
  const cruft = path.join(work, 'debug-scratch.js');
  fs.writeFileSync(cruft, '// would ship to prod\n');
  g = runGuard(workFwd);
  ok(g.rc === 1, `dirty tree (untracked) -> refuse (got rc=${g.rc})`);

  // (c') dirty tree + DEPLOY_UNSAFE=1 -> allow, result "override"
  g = runGuard(workFwd, { DEPLOY_UNSAFE: '1' });
  ok(g.rc === 0 && g.result === 'override', `dirty + DEPLOY_UNSAFE=1 -> allow/override (got rc=${g.rc} result=${g.result})`);
  fs.rmSync(cruft, { force: true });

  // (d) dirty tracked file (modified, not just untracked) -> refuse
  fs.writeFileSync(path.join(work, 'file.txt'), 'changed\n');
  g = runGuard(workFwd);
  ok(g.rc === 1, `modified tracked file -> refuse (got rc=${g.rc})`);
  git(['checkout', '-q', '--', 'file.txt'], work);

  // (e) unpushed main (local ahead of origin) -> refuse
  commit(work, 'file2.txt', 'local only, not pushed');
  g = runGuard(workFwd);
  ok(g.rc === 1, `local main ahead of origin/main -> refuse (got rc=${g.rc})`);
  git(['push', '-q', 'origin', 'main'], work); // resync
  g = runGuard(workFwd);
  ok(g.rc === 0 && g.result === 'clean', `after push, clean synced main -> allow again (got rc=${g.rc} result=${g.result})`);

  // ---- deploy_next_version: no tag yet -> v1.0.0 baseline, whatever the bump ----
  const notags = path.join(root, 'notags');
  mkRepo(notags);
  commit(notags, 'a.txt', 'first');
  const ntFwd = fwd(notags);
  ok(nextVersion(ntFwd, 'patch') === 'v1.0.0', 'no tag + patch -> v1.0.0');
  ok(nextVersion(ntFwd, 'minor') === 'v1.0.0', 'no tag + minor -> v1.0.0');
  ok(nextVersion(ntFwd, 'major') === 'v1.0.0', 'no tag + major -> v1.0.0');

  // ---- deploy_next_version: from an existing v1.2.0 tag ----
  git(['tag', '-a', 'v1.2.0', '-m', 'v1.2.0'], notags);
  ok(nextVersion(ntFwd, 'patch') === 'v1.2.1', 'v1.2.0 + patch -> v1.2.1');
  ok(nextVersion(ntFwd, 'minor') === 'v1.3.0', 'v1.2.0 + minor -> v1.3.0');
  ok(nextVersion(ntFwd, 'major') === 'v2.0.0', 'v1.2.0 + major -> v2.0.0');
  // default bump (no arg) is patch, the safe under-claim
  ok(nextVersion(ntFwd, '') === 'v1.2.1', 'v1.2.0 + (default) -> v1.2.1 (patch)');
  // picks the highest tag by version sort, not creation order
  git(['tag', '-a', 'v1.10.0', '-m', 'v1.10.0'], notags);
  ok(nextVersion(ntFwd, 'patch') === 'v1.10.1', 'version-sorted: v1.10.0 beats v1.2.0 -> v1.10.1');
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
