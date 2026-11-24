#!/bin/sh
# Pre-flight release guard for scripts/deploy.sh (live-money code - the tarball ships the
# WORKING TREE, so anything sitting in it ships to the production box).
#
# Functions only - no side effects at source time - so deploy.sh can `.` this file and
# scripts/test-deploy-guard.js can exercise the exact same logic against fixture repos.
#
#   deploy_preflight_guard <repo_dir>
#       Refuses (exit 1) unless the checkout is safe to ship:
#         (a) current branch is main (held work lives off main ON PURPOSE - a deploy from
#             a feature branch would ship it with no record),
#         (b) `git status --porcelain` is empty - modified, staged, AND untracked files all
#             land in the tarball, so a dirty tree means the box would diverge from git,
#         (c) local main matches origin/main after a fetch (an unpushed or stale main means
#             the tag we are about to create would not describe what GitHub says main is).
#       DEPLOY_UNSAFE=1 overrides every refusal with a loud multi-line warning; the caller
#       must then stamp dirty:true into version.json so the box records the shame.
#       Always prints the current package.json version and the last v* tag, so the human
#       picking the bump (patch/minor/major) has the context in front of them.
#
#   deploy_next_version <repo_dir> <bump>
#       Prints the next semver tag from the latest v* tag: patch|minor|major (default
#       patch - the safe under-claim; major must always be typed, never defaulted).
#       No v* tag yet -> v1.0.0 regardless of bump (the first guarded deploy baselines
#       "Module 1 as delivered plus accumulated fixes" with clean provenance).
#
#   deploy_box_version_check <repo_dir> <remote_read_cmd>
#       D068: "deploy this one small fix" ships EVERY commit on the branch since the box's OWN
#       running version, not just the intended change - a client-approved copy-wording fix once
#       also silently shipped an unrelated +5,109/-303 auth rework that had merged in the same
#       window. Runs <remote_read_cmd> (the caller's fully-built ssh invocation reading the box's
#       OWN version.json over ssh - never a written status doc, which goes stale, and never GET
#       /api/version, which sits behind the operator-session gate and 401s on a bare curl),
#       extracts its "sha" field, and lists every commit in <repo_dir> between that sha and HEAD so
#       the human reviews the actual blast radius before shipping. Never refuses on its own - an
#       unreachable box or an unreadable response prints a loud warning and returns 0, because a
#       deploy tool that cannot itself become the reason a fix cannot ship.
#
#   deploy_write_version_json <repo_dir> <version> <tag> <dirty:true|false>
#       Stamps <repo_dir>/version.json with the running-build provenance (version, tag, sha,
#       branch, build date, builder host, dirty). Called at package time; the file ships in
#       the tarball and the server reads it at boot. Pass tag="" for an unsafe ship (records
#       "tag": null); pass dirty=true so the box records that its tree was not clean git.
#
# A successful guard call sets DEPLOY_GUARD_RESULT for the caller: "clean" (nothing wrong) or
# "override" (problems, but DEPLOY_UNSAFE=1 forced it through). On a refusal the function
# returns 1 and the caller is expected to exit before reading the variable.

# shellcheck disable=SC2034  # DEPLOY_GUARD_RESULT is consumed by the deploy.sh that sources this file
deploy_last_tag() {
  # git's own version sort; sees every v* tag regardless of reachability from HEAD.
  git -C "$1" tag -l 'v[0-9]*' --sort=v:refname | tail -n 1
}

deploy_next_version() {
  _nv_dir="$1"
  _nv_bump="${2:-patch}"
  _nv_last="$(deploy_last_tag "$_nv_dir")"
  if [ -z "$_nv_last" ]; then
    # First guarded deploy is the v1.0.0 baseline (Module 1 is live in production;
    # semver FAQ: production software should already be 1.0.0).
    echo "v1.0.0"
    return 0
  fi
  _nv_vers="${_nv_last#v}"
  _nv_major="${_nv_vers%%.*}"
  _nv_rest="${_nv_vers#*.}"
  _nv_minor="${_nv_rest%%.*}"
  _nv_patch="${_nv_rest#*.}"
  case "$_nv_bump" in
    major) echo "v$((_nv_major + 1)).0.0" ;;
    minor) echo "v${_nv_major}.$((_nv_minor + 1)).0" ;;
    patch) echo "v${_nv_major}.${_nv_minor}.$((_nv_patch + 1))" ;;
    *) echo "unknown bump '$_nv_bump' (use patch|minor|major)" >&2; return 1 ;;
  esac
}

deploy_write_version_json() {
  _wv_dir="$1"
  _wv_version="$2"
  _wv_tag="$3"
  _wv_dirty="$4"
  _wv_sha="$(git -C "$_wv_dir" rev-parse HEAD 2>/dev/null || echo unknown)"
  _wv_branch="$(git -C "$_wv_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  _wv_built="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  _wv_host="$(hostname 2>/dev/null || echo unknown)"
  # An absent tag is JSON null (bare word); a present one is a quoted string.
  if [ -n "$_wv_tag" ]; then _wv_tag_json="\"$_wv_tag\""; else _wv_tag_json="null"; fi
  cat > "$_wv_dir/version.json" <<EOF
{
  "version": "$_wv_version",
  "tag": $_wv_tag_json,
  "sha": "$_wv_sha",
  "branch": "$_wv_branch",
  "builtAt": "$_wv_built",
  "builderHost": "$_wv_host",
  "dirty": $_wv_dirty
}
EOF
}

# shellcheck disable=SC2034  # DEPLOY_BOX_VERSION_CHECK_RESULT is consumed by callers that care
deploy_box_version_check() {
  _bv_dir="$1"
  _bv_cmd="$2"
  DEPLOY_BOX_VERSION_CHECK_RESULT="unknown"
  if [ -z "$_bv_cmd" ]; then
    echo "    box version: (no check command given - skipping blast-radius check)"
    return 0
  fi
  # eval, not exec: the caller hands a whole shell pipeline (ssh ... "curl ..."), not a single
  # argv - the same reason deploy.sh's own ssh/scp lines are built as strings, not arrays (sh has
  # no arrays).
  _bv_json="$(eval "$_bv_cmd" 2>/dev/null)" || _bv_json=""
  if [ -z "$_bv_json" ]; then
    echo "    box version: COULD NOT REACH the running box - blast radius since the last release could not be determined" >&2
    echo "    proceeding blind is a choice, not a default - confirm you know what is already on the box before continuing" >&2
    return 0
  fi
  _bv_sha="$(printf '%s' "$_bv_json" | sed -n 's/.*"sha" *: *"\([^"]*\)".*/\1/p')"
  if [ -z "$_bv_sha" ] || [ "$_bv_sha" = "unknown" ]; then
    echo "    box version: response carried no readable sha (${_bv_json}) - blast radius could not be determined" >&2
    return 0
  fi
  echo "    box is running: ${_bv_sha}"
  if ! git -C "$_bv_dir" cat-file -e "${_bv_sha}^{commit}" 2>/dev/null; then
    echo "    box sha ${_bv_sha} is not a commit known to this checkout (shallow clone? force-pushed history?) - cannot list what would ship" >&2
    return 0
  fi
  _bv_count="$(git -C "$_bv_dir" rev-list --count "${_bv_sha}..HEAD" 2>/dev/null || echo '?')"
  if [ "$_bv_count" = "0" ]; then
    echo "    this deploy ships NO new commits since the box's running version - nothing to review"
    DEPLOY_BOX_VERSION_CHECK_RESULT="none"
    return 0
  fi
  echo "    this deploy would ship ${_bv_count} commit(s) since the box's running version - review the blast radius before proceeding:"
  git -C "$_bv_dir" log --oneline "${_bv_sha}..HEAD" 2>/dev/null | sed 's/^/        /'
  DEPLOY_BOX_VERSION_CHECK_RESULT="listed"
}

deploy_preflight_guard() {
  _pg_dir="$1"
  _pg_branch="$(git -C "$_pg_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(unknown)')"
  _pg_dirty="$(git -C "$_pg_dir" status --porcelain 2>/dev/null)"
  _pg_last="$(deploy_last_tag "$_pg_dir")"
  _pg_pkg="$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$_pg_dir/package.json" 2>/dev/null | head -n 1)"

  echo "==> pre-flight guard"
  echo "    branch: ${_pg_branch} | package.json: ${_pg_pkg:-?} | last deploy tag: ${_pg_last:-(none - next deploy baselines v1.0.0)}"

  _pg_problems=""
  if [ "$_pg_branch" != "main" ]; then
    _pg_problems="${_pg_problems}    - not on main (on '${_pg_branch}') - held work lives off main on purpose; a deploy from here ships it
"
  fi
  if [ -n "$_pg_dirty" ]; then
    _pg_problems="${_pg_problems}    - working tree is not clean - these would ship in the tarball:
$(printf '%s\n' "$_pg_dirty" | sed 's/^/        /')
"
  fi
  # Sync check only makes sense on main; a wrong branch already refuses above.
  if [ "$_pg_branch" = "main" ]; then
    if git -C "$_pg_dir" fetch origin main --quiet 2>/dev/null; then
      _pg_local="$(git -C "$_pg_dir" rev-parse HEAD)"
      _pg_remote="$(git -C "$_pg_dir" rev-parse origin/main)"
      if [ "$_pg_local" != "$_pg_remote" ]; then
        _pg_problems="${_pg_problems}    - local main (${_pg_local}) != origin/main (${_pg_remote}) - push or pull first so the tag describes what GitHub says main is
"
      fi
    else
      _pg_problems="${_pg_problems}    - could not fetch origin/main (offline? bad remote?) - refusing rather than tagging blind
"
    fi
  fi

  if [ -z "$_pg_problems" ]; then
    DEPLOY_GUARD_RESULT=clean
    return 0
  fi

  if [ "${DEPLOY_UNSAFE:-}" = "1" ]; then
    DEPLOY_GUARD_RESULT=override
    echo "" >&2
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
    echo "!!  DEPLOY_UNSAFE=1 - SHIPPING AN UNSAFE TREE TO THE PRODUCTION BOX  !!" >&2
    echo "!!  The pre-flight guard would have refused this deploy because:     !!" >&2
    printf '%s' "$_pg_problems" >&2
    echo "!!  No release tag will be created. version.json is stamped          !!" >&2
    echo "!!  dirty:true so the box records that this state is not in git.     !!" >&2
    echo "!!  Redeploy from a clean main as soon as possible.                  !!" >&2
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
    echo "" >&2
    return 0
  fi

  echo "" >&2
  echo "REFUSING to deploy:" >&2
  printf '%s' "$_pg_problems" >&2
  echo "" >&2
  echo "Fix: checkout main, commit/stash/remove the files above, sync with origin, rerun." >&2
  echo "Emergency escape hatch (records dirty:true on the box): DEPLOY_UNSAFE=1 sh scripts/deploy.sh" >&2
  return 1
}
