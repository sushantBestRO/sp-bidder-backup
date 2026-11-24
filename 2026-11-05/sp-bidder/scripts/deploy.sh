#!/bin/sh
# Deploy the SuperProcure auto-bidder to the VPS: build the console locally, ship the
# app, install prod deps, and restart ONLY the bid-command PM2 process. Touches nothing
# else on the box. Review before first run.
#
# Creds come from ~/.secrets/suyashh/deploy.env (outside any repo). This file holds none.
# Needed vars: SUYASHH_VPS_USER, SUYASHH_VPS_IP, SUYASHH_VPS_PASSWORD,
#              SUYASHH_VPS_SSH_PORT (default 22),
#              SUYASHH_VPS_APP_DIR (default /home/best-app/sp-bidder - the live app dir;
#              we SSH as root, so a bare relative default would land in /root).
#
# Usage:  sh scripts/deploy.sh [patch|minor|major]
#
# The argument is the semver bump for the release tag created at deploy time (bump rulebook
# in DEPLOY.md > "Release provenance"). No argument = patch, the safe under-claim; `major`
# must always be typed deliberately. A pre-flight guard refuses to ship anything that is not
# clean, pushed main (the tarball ships the WORKING TREE); DEPLOY_UNSAFE=1 overrides
# with a loud warning, skips the tag, and stamps dirty:true into version.json.
set -eu

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUMP="${1:-patch}"
SECRETS="$HOME/.secrets/suyashh/deploy.env"
[ -f "$SECRETS" ] || { echo "Missing secrets file: $SECRETS" >&2; exit 1; }
# shellcheck disable=SC1090
. "$SECRETS"
# shellcheck disable=SC1091
. "$APP_DIR/scripts/deploy-guard.sh"

# ---- pre-flight: refuse an unsafe tree, then tag this deploy ----
# Runs BEFORE anything is built, packaged, or shipped. The tarball ships the working tree, so
# a non-main / dirty / unpushed checkout would all reach the production box - the guard refuses
# all three. DEPLOY_UNSAFE=1 overrides with a loud warning and ships unversioned + dirty:true.
deploy_preflight_guard "$APP_DIR" || exit 1

if [ "${DEPLOY_GUARD_RESULT:-}" = "override" ]; then
  # Unsafe ship: no release tag; version.json records version=dev + dirty:true so the box is
  # honest that it is running something that is not a clean release.
  VERSION="dev"; TAG=""; DIRTY=true
  echo "==> unsafe deploy: NO release tag will be created (DEPLOY_UNSAFE=1)"
else
  # Clean main deploy: compute the next semver from the bump the human passed (patch default),
  # show it, and let them confirm or override the exact tag before it is created + pushed.
  VERSION="$(deploy_next_version "$APP_DIR" "$BUMP")" || exit 1
  TAG="$VERSION"; DIRTY=false
  printf '\n==> release tag %s  (bump=%s, HEAD=%s, last tag=%s)\n' \
    "$TAG" "$BUMP" "$(git -C "$APP_DIR" rev-parse --short HEAD)" "$(deploy_last_tag "$APP_DIR" || echo none)"
  printf '    press Enter to tag+push %s, or type a different vX.Y.Z: ' "$TAG"
  read _tag_confirm || _tag_confirm=""
  if [ -n "$_tag_confirm" ]; then
    case "$_tag_confirm" in
      v[0-9]*.[0-9]*.[0-9]*) TAG="$_tag_confirm"; VERSION="$_tag_confirm" ;;
      *) echo "not a vX.Y.Z tag: '$_tag_confirm' - aborting deploy" >&2; exit 1 ;;
    esac
  fi
  # Annotated tag at HEAD, pushed before shipping so the tag describes exactly what goes to the
  # box (a push failure aborts here, leaving the local tag to retry once the network is back).
  git -C "$APP_DIR" tag -a "$TAG" -m "deploy $TAG ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  git -C "$APP_DIR" push origin "$TAG"
  echo "    tagged + pushed $TAG"
fi

# Stamp the provenance file that ships in the tarball and the server reads at boot.
deploy_write_version_json "$APP_DIR" "$VERSION" "$TAG" "$DIRTY"
echo "==> version.json stamped (version=$VERSION tag=${TAG:-none} dirty=$DIRTY)"

PORT="${SUYASHH_VPS_SSH_PORT:-22}"
REMOTE="${SUYASHH_VPS_USER}@${SUYASHH_VPS_IP}"
REMOTE_DIR="${SUYASHH_VPS_APP_DIR:-/home/best-app/sp-bidder}"

# --- password-based ssh/scp via askpass (same pattern as ssh-vps.sh) ---
ASKPASS="$(mktemp)"
# Pre-declared so the EXIT trap can reference them before the packaging step assigns them - with
# `set -u` an early exit (e.g. a failed console build) would otherwise fail inside the trap.
TARBALL=""; MEMBERS=""; PACKED=""
trap 'rm -f "$ASKPASS" "$TARBALL" "$MEMBERS" "$PACKED"' EXIT
printf '#!/bin/sh\nprintf "%%s\\n" "$SUYASHH_VPS_PASSWORD"\n' > "$ASKPASS"
chmod +x "$ASKPASS"
SSH_ASKPASS="$ASKPASS"; SSH_ASKPASS_REQUIRE=force; DISPLAY=:0
export SUYASHH_VPS_PASSWORD SSH_ASKPASS SSH_ASKPASS_REQUIRE DISPLAY
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=1"

echo "==> 1/4 building the React console locally"
( cd "$APP_DIR" && npm run build:console )
[ -f "$APP_DIR/dashboard/dist/index.html" ] || { echo "build produced no dist/index.html" >&2; exit 1; }

echo "==> 2/4 packaging the app (git-tracked tree + build artifacts; internal-only paths never ship)"
TARBALL="$(mktemp).tgz"
MEMBERS="$(mktemp)"
PACKED="$(mktemp)"

# ---- the internal-only manifest: ONE list, THREE consumers -----------------------------------
# (1) the packer just below, (2) the remote prune in step 4/4 that deletes copies earlier deploys
# already left on the box, and (3) scripts/test-deploy-package-excludes.js, which fails `npm test`
# if any consumer drifts from this list. None of it is a BRL deliverable, and the /review,
# /diagnose and /test-writing reports enumerate unfixed defects in this live-money app - a leak
# is a client-facing incident, not untidiness.
DEPLOY_INTERNAL_PATHS='CLAUDE.md CLAUDE.local.md .claude docs/reviews docs/diagnoses docs/tests docs/screenshots debug-menu.js debug-menu-v2.js verify-bidder-checks.js verify-bidder-final.js'
# Not internal, just no business on the box: the console SOURCE (only dashboard/dist/ deploys),
# plus a belt on secrets and runtime state in case one is ever committed by accident.
DEPLOY_UNSHIPPED_PATHS='dashboard/src data .env'

# Members come from GIT's view of the tree, not from a raw directory walk:
#   --cached                     tracked files (content still read from the WORKING TREE)
#   --others --exclude-standard  untracked files that are NOT gitignored
# That is exactly the file universe deploy-guard.sh inspects via `git status --porcelain`, so the
# guard and the packer can no longer disagree. The old form (`tar -C "$APP_DIR" ... -czf
# "$TARBALL" .`) walked the whole tree, and tar does not read .gitignore - so a gitignored stray
# was invisible to the guard AND unfiltered by the packer, and shipped silently on a clean,
# tagged, green deploy (that is how test-output.log and scripts/ui-audit-screenshots/ rode along).
# Gitignored now means unpackable; the only exceptions are the two build artifacts named below.
_ps=''
for _p in $DEPLOY_INTERNAL_PATHS $DEPLOY_UNSHIPPED_PATHS; do
  _ps="$_ps :(exclude)$_p"
done
{
  # shellcheck disable=SC2086  # $_ps is a deliberately word-split pathspec list
  git -C "$APP_DIR" ls-files -z --cached --others --exclude-standard -- . $_ps
  # The allow-list - gitignored ON PURPOSE, produced by this deploy, and required on the box:
  #   version.json    release-provenance stamp, read by src/web/version.js at boot
  #   dashboard/dist  the React console built in step 1/4
  printf '%s\0' version.json
  ( cd "$APP_DIR" && find dashboard/dist -type f -print0 )
} > "$MEMBERS"
tar -C "$APP_DIR" --null --no-recursion -T "$MEMBERS" -czf "$TARBALL"

# ---- prove the archive before it leaves this machine ------------------------------------------
# Everything above is structural; this reads the FINISHED tarball, so it also catches a bug in the
# member logic itself. A leak aborts the deploy - it never warns and continues.
tar -tzf "$TARBALL" | sed 's#^\./##' > "$PACKED"
_leaked=''
for _p in $DEPLOY_INTERNAL_PATHS; do
  while IFS= read -r _m; do
    case "$_m" in "$_p"|"$_p"/*) _leaked="$_leaked $_p"; break ;; esac
  done < "$PACKED"
done
[ -z "$_leaked" ] || { echo "REFUSING to ship: internal-only path(s) in the tarball:$_leaked" >&2; exit 1; }
# The mirror check: an over-broad exclusion silently drops deliverables, which is just as bad a
# deploy and much harder to notice on the box.
for _p in package.json src/web/server.js version.json dashboard/dist/index.html; do
  grep -qxF "$_p" "$PACKED" || { echo "REFUSING to ship: deliverable '$_p' missing from the tarball" >&2; exit 1; }
done
echo "    packaged $(wc -l < "$PACKED" | tr -d ' ') files - internal-only: 0"

# D068: "deploy this one small fix" ships EVERY commit on the branch since the box's OWN running
# version, not just the intended change - read it LIVE (never trust a written status doc, which
# goes stale) and list the actual blast radius before anything ships. GET /api/version sits below
# the operator-session gate (server.js's /api guard), so a bare curl gets 401 every time - this
# reads the same provenance straight off the file it comes from instead (version.json in the app
# dir, stamped by deploy_write_version_json above and read by src/web/version.js at boot), over the
# same ssh session everything else here uses.
echo "==> pre-ship: box version + blast radius"
# shellcheck disable=SC2086
deploy_box_version_check "$APP_DIR" "ssh -p \"$PORT\" $SSH_OPTS \"$REMOTE\" \"cat '$REMOTE_DIR/version.json' 2>/dev/null\""

echo "==> 3/4 shipping to ${REMOTE}:${REMOTE_DIR}"
# shellcheck disable=SC2086
ssh -p "$PORT" $SSH_OPTS "$REMOTE" "mkdir -p '$REMOTE_DIR'"
# shellcheck disable=SC2086
scp -P "$PORT" $SSH_OPTS "$TARBALL" "$REMOTE:$REMOTE_DIR/_deploy.tgz"

echo "==> 4/4 installing + restarting bid-command (this app only)"
# NOTE: a plain 'pm2 restart bid-command' on purpose, NOT 'pm2 startOrReload ecosystem'.
# startOrReload re-evaluates ecosystem.config.cjs env on the box, where the shell has no
# PLATFORM, so the \`PLATFORM || 'real'\` fallback would FLIP a mock/demo box to real mode.
# A plain restart keeps the env the process was registered with (PLATFORM=mock stays mock);
# the app still re-reads .env via dotenv on boot, so new keys (e.g. SP_MAYTAPI_*) load fine.
# The ecosystem start only runs on a box where the process does not exist yet (first deploy).
# shellcheck disable=SC2086
ssh -p "$PORT" $SSH_OPTS "$REMOTE" "sh -lc '
  set -eu
  cd \"$REMOTE_DIR\"
  tar -xzf _deploy.tgz && rm -f _deploy.tgz
  # \`tar -x\` only creates and overwrites - it NEVER removes members that have left the archive.
  # So every internal-only file shipped by a deploy made before the exclude list existed is still
  # sitting in this directory, and excluding it from future tarballs does not remove it. Delete
  # them here, on every deploy, so the box converges. The list mirrors DEPLOY_INTERNAL_PATHS
  # above; scripts/test-deploy-package-excludes.js fails npm test if the two ever drift. Targets
  # are ./-relative on purpose: nothing here can walk out of \$REMOTE_DIR.
  rm -rf ./CLAUDE.md ./CLAUDE.local.md ./.claude ./docs/reviews ./docs/diagnoses ./docs/tests ./docs/screenshots
  rm -rf ./debug-menu.js ./debug-menu-v2.js ./verify-bidder-checks.js ./verify-bidder-final.js
  echo \"   pruned internal-only paths (CLAUDE*.md, .claude, docs/reviews, docs/diagnoses, docs/tests, docs/screenshots, debug+verify throwaways)\"
  npm install --omit=dev
  mkdir -p data/logs
  [ -f .env ] || { echo \"!! no .env on the box - create it (chmod 600) before this will run in real mode\"; }
  if pm2 describe bid-command >/dev/null 2>&1; then
    pm2 restart bid-command
  else
    echo \"bid-command not registered yet - first start from ecosystem.config.cjs\"
    pm2 start ecosystem.config.cjs
  fi
  pm2 describe bid-command | grep -E \"status|restarts\" || true
'"

echo
echo "Done. bid-command restarted. Other PM2 apps were not touched."
echo "Verify with:  sh scripts/ssh-vps.sh 'pm2 list'"
echo "If every app shows online, persist the list:  sh scripts/ssh-vps.sh 'pm2 save'"
