'use strict';

// Regression guard for the deploy tarball's internal-only leak controls.
//
// scripts/deploy.sh ships a tarball to BRL's production box. Three things have to hold, and a
// break in any one of them puts our internal working material - /review, /diagnose and
// /test-writing reports that name unfixed defects in this live-money app - on a client machine:
//
//   1. the PACKER must not put internal-only paths in the archive,
//   2. the remote PRUNE must delete copies that older deploys already left on the box
//      (`tar -x` only adds and overwrites - it never removes members that left the archive),
//   3. the packer's file universe must be the SAME universe deploy-guard.sh inspects, or one
//      half reads clean while the other leaks.
//
// This test reads deploy.sh + deploy-guard.sh as the single source of truth and pins all three
// against the canonical manifest below, so drift fails `npm test` (and therefore CI) instead of
// being discovered on the client's box. It asserts the LIST and the MECHANISM; that the
// mechanism strips what it claims is enforced at run time by deploy.sh's own pre-ship
// verification of the finished archive, which is itself asserted here.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log('  ok  ' + m); };

const repoRoot = path.join(__dirname, '..');
const deploySh = fs.readFileSync(path.join(__dirname, 'deploy.sh'), 'utf8');
const guardSh = fs.readFileSync(path.join(__dirname, 'deploy-guard.sh'), 'utf8');

// ---------------------------------------------------------------------------------------------
// The canonical internal-only manifest. Adding an internal artifact class to the repo means
// adding it HERE and in deploy.sh - this test enforces both directions, so neither can drift.
// ---------------------------------------------------------------------------------------------
const INTERNAL_MANIFEST = [
  'CLAUDE.md',               // internal Claude guidance
  'CLAUDE.local.md',         // internal Claude context
  '.claude',                 // internal Claude tooling (skills, settings)
  'docs/reviews',            // local /review master + specialist reports
  'docs/diagnoses',          // local /diagnose writeups
  'docs/tests',              // local /test-writing reports - these enumerate unfixed defects
  'docs/screenshots',        // local UI evidence captures - internal working material, and heavy
  'debug-menu.js',           // one-off puppeteer debug throwaways
  'debug-menu-v2.js',
  'verify-bidder-checks.js', // one-off puppeteer verify throwaways
  'verify-bidder-final.js',
];

// Gitignored paths the packer may ship BY NAME. Both are build output produced by the deploy
// itself, not tree cruft. This is the only door a gitignored file can come through, so the list
// staying exactly these two entries is part of the contract.
const ALLOWED_BUILD_ARTIFACTS = ['version.json', 'dashboard/dist'];

// Real deliverables. Every one is checked to EXIST - a MUST_SHIP entry that is not in the tree
// is a vacuous assertion that passes forever while proving nothing.
const MUST_SHIP = [
  'package.json',
  'ecosystem.config.cjs',
  'src/web/server.js',
  'src/engine/bidEngine.js',
  'scripts/run-tests.js',
  'docs/CSV_EXPORTS_SCOPE.md',
  'docs/SOFT_CLOSE_BID_LOGIC.md',
];
// Deliverables produced at deploy time, so they are absent from a fresh checkout - checked for
// over-exclusion only, not for existence.
const MUST_SHIP_BUILD = ['version.json', 'dashboard/dist/index.html'];

// ---------------------------------------------------------------------------------------------
// 1. The packer's member list comes from git, not from a raw directory walk.
// ---------------------------------------------------------------------------------------------
// `tar -C "$APP_DIR" ... -czf "$TARBALL" .` walked the whole working tree. tar does not read
// .gitignore, so a gitignored stray (test-output.log, scripts/ui-audit-screenshots/) was
// invisible to the guard AND unfiltered by the packer: it shipped on a clean, tagged, green
// deploy with no operator signal. Sourcing members from git closes that channel by construction.
ok(
  /git -C "\$APP_DIR" ls-files -z --cached --others --exclude-standard/.test(deploySh),
  'packer builds its member list from `git ls-files --cached --others --exclude-standard`',
);
ok(
  !/-czf "\$TARBALL" \.\s*$/m.test(deploySh),
  'packer no longer walks the working tree with a bare `tar ... -czf "$TARBALL" .`',
);
ok(
  /--null --no-recursion -T "\$MEMBERS"/.test(deploySh),
  'tar reads that member list (`--null --no-recursion -T "$MEMBERS"`) instead of recursing',
);

// The guard half of the same contract. `git status --porcelain` reports tracked changes and
// untracked-not-ignored files - exactly the universe `ls-files --cached --others
// --exclude-standard` packs. Change either side and the two halves stop agreeing.
ok(
  /git -C "\$_pg_dir" status --porcelain/.test(guardSh),
  'deploy-guard.sh still gates on `git status --porcelain` (same file universe as the packer)',
);

// ---------------------------------------------------------------------------------------------
// 2. The internal-only list in deploy.sh matches the canonical manifest exactly.
// ---------------------------------------------------------------------------------------------
const internalDecl = deploySh.match(/^DEPLOY_INTERNAL_PATHS='([^']*)'/m);
ok(internalDecl !== null, 'deploy.sh declares DEPLOY_INTERNAL_PATHS');
const declaredInternal = internalDecl[1].split(/\s+/).filter(Boolean);

for (const p of INTERNAL_MANIFEST) {
  ok(declaredInternal.includes(p), `packer excludes internal-only path '${p}'`);
}
const unexpected = declaredInternal.filter((p) => !INTERNAL_MANIFEST.includes(p));
ok(
  unexpected.length === 0,
  `DEPLOY_INTERNAL_PATHS holds nothing outside the manifest (extra: ${unexpected.join(', ') || 'none'})`,
);

// The list has to actually reach the git invocation - the loop that turns each entry into a
// `:(exclude)` pathspec is what makes the declaration load-bearing rather than decorative.
ok(
  /for _p in \$DEPLOY_INTERNAL_PATHS \$DEPLOY_UNSHIPPED_PATHS/.test(deploySh)
    && /:\(exclude\)\$_p/.test(deploySh),
  'every declared path is fed to git as a `:(exclude)` pathspec',
);

// ---------------------------------------------------------------------------------------------
// 3. The remote prune covers the same manifest.
// ---------------------------------------------------------------------------------------------
// Without this the fix only protects FUTURE deploys: copies shipped before the exclude list
// existed sit in the app dir on the box forever, because `tar -x` never deletes. The prune runs
// inside the remote `sh -lc` block, after extract.
const remoteStart = deploySh.indexOf('ssh -p "$PORT" $SSH_OPTS "$REMOTE" "sh -lc \'');
ok(remoteStart !== -1, 'the remote install step is still an `ssh ... "sh -lc \'...\'"` block');
const remoteBlock = deploySh.slice(remoteStart);

const extractAt = remoteBlock.indexOf('tar -xzf _deploy.tgz');
ok(extractAt !== -1, 'the remote block still extracts the tarball');

const pruneMatches = [...remoteBlock.matchAll(/rm -rf ((?:\S+[ \t]*)+)/g)];
const prunedPaths = pruneMatches
  .flatMap((m) => m[1].trim().split(/\s+/))
  .map((p) => p.replace(/^\.\//, ''));
ok(prunedPaths.length > 0, 'the remote block prunes internal-only paths');
ok(
  pruneMatches.every((m) => m.index > extractAt),
  'the prune runs AFTER extract (so it also catches anything the archive still carried)',
);
for (const p of INTERNAL_MANIFEST) {
  ok(prunedPaths.includes(p), `remote prune removes already-shipped '${p}' from the box`);
}
const prunedExtra = prunedPaths.filter((p) => !INTERNAL_MANIFEST.includes(p));
ok(
  prunedExtra.length === 0,
  `remote prune deletes nothing outside the manifest (extra: ${prunedExtra.join(', ') || 'none'})`,
);
// The prune deletes on a production box: every target must be app-relative, so no expansion
// accident can walk out of $REMOTE_DIR.
ok(
  pruneMatches.flatMap((m) => m[1].trim().split(/\s+/)).every((p) => p.startsWith('./')),
  'every remote prune target is `./`-relative (cannot escape the app dir)',
);

// ---------------------------------------------------------------------------------------------
// 4. The gitignored-artifact allow-list stays exactly two entries.
// ---------------------------------------------------------------------------------------------
// These two are appended to the member list by name, so they are the only way a gitignored path
// can reach the box. Widening this list re-opens the channel the git-sourced list just closed.
const namedAppends = [...deploySh.matchAll(/printf '%s\\0' (\S+)/g)].map((m) => m[1])
  .concat([...deploySh.matchAll(/find (\S+) -type f/g)].map((m) => m[1]));
for (const p of ALLOWED_BUILD_ARTIFACTS) {
  ok(namedAppends.includes(p), `build artifact '${p}' is appended to the member list by name`);
}
const artifactExtra = namedAppends.filter((p) => !ALLOWED_BUILD_ARTIFACTS.includes(p));
ok(
  artifactExtra.length === 0,
  `no gitignored path ships beyond the allow-list (extra: ${artifactExtra.join(', ') || 'none'})`,
);

// ---------------------------------------------------------------------------------------------
// 5. Over-exclusion: no exclusion token may swallow a real deliverable.
// ---------------------------------------------------------------------------------------------
// Exact-string non-membership only catches an over-exclusion spelled as the identical literal.
// The realistic regressions are pattern-shaped - `docs`, `docs/*`, `*.md` - and every one of
// them leaves a literal check green while deliverables vanish. This matches how git pathspec
// actually resolves: a leading-directory match, plus `*` / `**` globbing.
const unshippedDecl = deploySh.match(/^DEPLOY_UNSHIPPED_PATHS='([^']*)'/m);
ok(unshippedDecl !== null, 'deploy.sh declares DEPLOY_UNSHIPPED_PATHS');
const excludeTokens = declaredInternal.concat(unshippedDecl[1].split(/\s+/).filter(Boolean));

const swallows = (token, target) => {
  if (token.includes('*')) {
    const body = token
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, ' ')
      .replace(/\*/g, '[^/]*')
      .replace(/ /g, '.*');
    return new RegExp(`^${body}(/|$)`).test(target);
  }
  return target === token || target.startsWith(token + '/');
};
for (const target of MUST_SHIP.concat(MUST_SHIP_BUILD)) {
  const hit = excludeTokens.find((t) => swallows(t, target));
  ok(hit === undefined, `no exclusion token swallows deliverable '${target}' (hit: ${hit || 'none'})`);
}
// A MUST_SHIP entry that is not in the tree asserts nothing. Pin them to reality.
for (const p of MUST_SHIP) {
  ok(
    fs.existsSync(path.join(repoRoot, p)),
    `deliverable '${p}' exists in the tree (assertion is not vacuous)`,
  );
}

// ---------------------------------------------------------------------------------------------
// 6. deploy.sh verifies the built archive before it leaves this machine.
// ---------------------------------------------------------------------------------------------
// Everything above checks the manifest and the wiring. This is the backstop for a bug in the
// member logic itself: deploy.sh lists the finished tarball and refuses to ship if any internal
// path is inside it, or if a known deliverable is missing.
ok(
  /tar -tzf "\$TARBALL"/.test(deploySh),
  'deploy.sh lists the finished tarball to verify it before shipping',
);
ok(
  /REFUSING to ship: internal-only path/.test(deploySh),
  'a verified leak aborts the deploy (refuses to ship) rather than warning',
);
ok(
  /REFUSING to ship: deliverable/.test(deploySh),
  'a missing deliverable also aborts the deploy (catches over-exclusion at pack time)',
);

console.log(`\n${pass} passed, 0 failed`);
