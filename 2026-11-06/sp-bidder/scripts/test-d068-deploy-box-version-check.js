'use strict';
/**
 * Pins D068 (fix/ops-alerting-divergences).
 *
 * The deploy pre-flight printed branch, package.json version and the last v* tag, but never read
 * the box's OWN running version or listed the commits between it and HEAD - "deploy this one small
 * fix" shipped every commit since the last release with nobody surfacing the blast radius.
 * deploy_box_version_check(repo_dir, remote_read_cmd) now does both: runs the caller's ssh
 * invocation against the box, reads its "sha", and lists every commit since it.
 *
 * remote_read_cmd is evaluated as a shell command; most cases below pass `echo '<json>'` in its
 * place, so no real network/ssh is exercised. The last section is different: it extracts deploy.sh's
 * OWN command line verbatim and runs it against a stub `ssh` (review finding, 26 Sep - the original
 * shape curled GET /api/version, which sits behind the operator-session gate and 401s every time;
 * the fix reads version.json over ssh instead), so that one pin proves the REAL shape, not an echo.
 *
 * Needs `sh` and `git` to be spawnable - same skip-cleanly convention as test-deploy-guard.js.
 *
 *   node scripts/test-d068-deploy-box-version-check.js
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fwd = (p) => p.replace(/\\/g, '/');
const GUARD = fwd(path.join(__dirname, 'deploy-guard.sh'));
// PATH entries need POSIX drive prefixes (/c/...), not fwd()'s C:/... - bash's own PATH search
// (unlike a plain argument, which MSYS auto-translates) does not recognize a Windows-style drive
// path there, so a prepended stub bin dir silently loses to the real /usr/bin on Windows Git Bash.
const toPosixPath = (p) => /^[A-Za-z]:/.test(p) ? `/${p[0].toLowerCase()}${fwd(p).slice(2)}` : fwd(p);

function shOk() { const r = spawnSync('sh', ['-c', 'exit 0'], { encoding: 'utf8' }); return !r.error && r.status === 0; }
function gitOk() { const r = spawnSync('git', ['--version'], { encoding: 'utf8' }); return !r.error && r.status === 0; }

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
  fs.writeFileSync(path.join(dir, file), `${msg}\n`);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', msg], dir);
  return git(['rev-parse', 'HEAD'], dir).trim();
}
// Runs deploy_box_version_check inside a real sh, returning { rc, stdout, stderr, result }.
function runCheck(dirFwd, remoteCmd) {
  const script = `. "${GUARD}"; rc=0; deploy_box_version_check "${dirFwd}" '${remoteCmd.replace(/'/g, "'\\''")}' >__out 2>__err || rc=$?; echo "RC=$rc RESULT=${'$'}{DEPLOY_BOX_VERSION_CHECK_RESULT:-none}"; echo "---STDOUT---"; cat __out; echo "---STDERR---"; cat __err`;
  const r = spawnSync('sh', ['-c', script], { encoding: 'utf8', cwd: dirFwd });
  const m = /RC=(\d+) RESULT=(\S+)/.exec(r.stdout || '');
  const stdout = (r.stdout || '').split('---STDOUT---')[1] || '';
  const stderr = (stdout.split('---STDERR---')[1] || '');
  return { rc: m ? Number(m[1]) : -1, result: m ? m[2] : 'parse-error', stdout, raw: r.stdout, err: r.stderr };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-boxver-'));
try {
  const work = path.join(root, 'work');
  mkRepo(work);
  const sha1 = commit(work, 'a.txt', 'first commit');
  const sha2 = commit(work, 'b.txt', 'second commit');
  commit(work, 'c.txt', 'third commit');
  const workFwd = fwd(work);

  // ---- box is exactly at HEAD: nothing to review ----
  {
    const headSha = git(['rev-parse', 'HEAD'], work).trim();
    const r = runCheck(workFwd, `echo '{"sha":"${headSha}"}'`);
    ok(r.rc === 0, `the function is callable and exits 0 (got rc=${r.rc}: ${r.raw})`);
    ok(r.result === 'none', `D068: box already at HEAD reports result=none (no commits to ship), got ${r.result}: ${r.raw}`);
  }

  // ---- box is behind HEAD by 2 commits: lists exactly those 2, oldest last (git log order) ----
  {
    const r = runCheck(workFwd, `echo '{"sha":"${sha1}"}'`);
    ok(r.result === 'listed', `D068: box behind HEAD reports result=listed, got ${r.result}: ${r.raw}`);
    ok(r.stdout.includes('second commit') && r.stdout.includes('third commit') && !r.stdout.includes('first commit'),
      `D068: lists exactly the commits since the box's sha (exclusive), not the box's own commit: ${r.stdout}`);
  }

  // ---- box unreachable (command fails / empty output): warns, never fails the deploy ----
  {
    const r = runCheck(workFwd, 'false'); // a command that exits non-zero with no output
    ok(r.rc === 0, `D068: an unreachable box never fails the pre-flight (advisory only), got rc=${r.rc}`);
    ok(r.result === 'unknown', `D068: an unreachable box reports result=unknown, got ${r.result}`);
  }

  // ---- box response carries no readable sha: warns, never fails ----
  {
    const r = runCheck(workFwd, "echo '{\"version\":\"dev\"}'");
    ok(r.rc === 0, 'D068: an unreadable sha never fails the pre-flight');
    ok(r.result === 'unknown', `D068: an unreadable sha reports result=unknown, got ${r.result}`);
  }

  // ---- box sha unknown to this checkout (e.g. a shallow clone): warns, never fails ----
  {
    const r = runCheck(workFwd, `echo '{"sha":"0000000000000000000000000000000000000000"}'`);
    ok(r.rc === 0, 'D068: an unrecognized box sha never fails the pre-flight');
    ok(r.result === 'unknown', `D068: an unrecognized box sha reports result=unknown, got ${r.result}`);
  }

  // ---- no command configured at all: silent no-op, never fails ----
  {
    const r = runCheck(workFwd, '');
    ok(r.rc === 0, 'D068: no configured check command is a silent no-op, never a failure');
  }

  // ---- review finding (26 Sep): deploy.sh's REAL command reads version.json over ssh, not
  // /api/version over curl. Extracts the actual `deploy_box_version_check "$APP_DIR" "ssh ..."`
  // line out of scripts/deploy.sh, points $REMOTE_DIR at a fixture dir holding version.json, and
  // runs it against a stub `ssh` on PATH that ignores the connection flags and evals the trailing
  // remote-command string LOCALLY - so this exercises the exact shell text that ships, with only
  // the network hop faked out, not a hand-typed echo standing in for the whole line.
  {
    const deployShLines = fs.readFileSync(path.join(__dirname, 'deploy.sh'), 'utf8').split('\n');
    const callLine = deployShLines.find((l) => l.trim().startsWith('deploy_box_version_check "$APP_DIR"'));
    ok(!!callLine, `fixture: found deploy.sh's real deploy_box_version_check call line, got: ${callLine}`);
    ok(!/curl|\/api\/version/.test(callLine || ''),
      `D068: deploy.sh no longer curls the session-gated /api/version, got: ${callLine}`);
    ok(/cat .*version\.json/.test(callLine || ''),
      `D068: deploy.sh reads version.json instead, got: ${callLine}`);

    const remoteDir = path.join(root, 'remote-box');
    fs.mkdirSync(remoteDir, { recursive: true });
    const boxSha = sha1;
    fs.writeFileSync(path.join(remoteDir, 'version.json'), JSON.stringify({ sha: boxSha, version: 'v1.2.3' }));

    const stubBinDir = path.join(root, 'stub-bin');
    fs.mkdirSync(stubBinDir, { recursive: true });
    // Ignores every ssh connection flag; evals only the trailing remote-command argument, locally.
    const stubSsh = path.join(stubBinDir, 'ssh');
    fs.writeFileSync(stubSsh, '#!/bin/sh\nfor a in "$@"; do last="$a"; done\neval "$last"\n', { mode: 0o755 });
    // fs.writeFileSync's mode is a Windows no-op - Git Bash's PATH search skips a file it does not
    // see as executable, silently falling through to the real /usr/bin/ssh instead of this stub.
    // A real chmod through sh actually sets the bit MSYS honors.
    spawnSync('sh', ['-c', `chmod +x "${fwd(stubSsh)}"`]);

    const harness = `PATH="${toPosixPath(stubBinDir)}:$PATH"; APP_DIR="${workFwd}"; PORT="22"; SSH_OPTS=""; `
      + `REMOTE="deploy@127.0.0.1"; REMOTE_DIR="${fwd(remoteDir)}"; . "${GUARD}"; rc=0; ${callLine.trim()} `
      + '>__out 2>__err || rc=$?; echo "RC=$rc RESULT=${DEPLOY_BOX_VERSION_CHECK_RESULT:-none}"; echo "---STDOUT---"; cat __out';
    const r = spawnSync('sh', ['-c', harness], { encoding: 'utf8', cwd: workFwd });
    const m = /RC=(\d+) RESULT=(\S+)/.exec(r.stdout || '');
    const result = m ? m[2] : 'parse-error';
    ok(m && Number(m[1]) === 0, `D068: the real deploy.sh command line runs clean end to end (rc=0), got: ${JSON.stringify(r)}`);
    ok(result === 'listed',
      `D068: reading the box's actual version.json (sha=${sha1.slice(0, 7)}, 2 commits behind HEAD) reports result=listed, got ${result}: ${r.stdout}`);
    ok((r.stdout || '').includes('second commit') && (r.stdout || '').includes('third commit'),
      `D068: lists the real blast radius off the real command line: ${r.stdout}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
