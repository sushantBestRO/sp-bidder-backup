#!/bin/sh
# Build a BEFORE and an AFTER screenshot set for the GoComet price page.
#
# BEFORE is an export of the base branch, so the old page is rendered by the old code rather than
# by the new code with facts withheld - the difference has to be real to be worth looking at.
#
#   sh scripts/preview-gocomet-facts.sh <out-dir> [base-ref]
#
# <out-dir> MUST be outside this repo. scripts/deploy.sh ships the working tree, so generated PNGs
# left in here would be copied onto the client's production box.
set -e
OUT="$1"
BASE="${2:-origin/main}"
[ -n "$OUT" ] || { echo "usage: sh scripts/preview-gocomet-facts.sh <out-dir> [base-ref]" >&2; exit 2; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
case "$OUT" in "$ROOT"*) echo "refusing: <out-dir> is inside the repo and would ship on the next deploy" >&2; exit 2;; esac
mkdir -p "$OUT"

WORK="$OUT/.trees"
rm -rf "$WORK"
mkdir -p "$WORK/before"
git -C "$ROOT" archive "$BASE" | tar -x -C "$WORK/before"
# The base tree needs the same dependencies and the same captured fixtures. node_modules is linked
# rather than installed: an install here would be several minutes for a screenshot, and on Windows
# `npm --prefix` has destroyed a .git in this repo before.
cp -r "$ROOT/scripts/fixtures" "$WORK/before/scripts/" 2>/dev/null || true
cp "$ROOT/scripts/preview-gocomet-facts.mjs" "$WORK/before/scripts/"
ln -s "$ROOT/node_modules" "$WORK/before/node_modules" 2>/dev/null \
  || cp -r "$ROOT/node_modules" "$WORK/before/node_modules"
[ -d "$ROOT/dashboard/dist" ] && cp -r "$ROOT/dashboard/dist" "$WORK/before/dashboard/dist" 2>/dev/null || true

echo "== BEFORE ($BASE) =="
node "$WORK/before/scripts/preview-gocomet-facts.mjs" --root "$WORK/before" --out "$OUT" --label before
echo "== AFTER (working tree) =="
node "$ROOT/scripts/preview-gocomet-facts.mjs" --root "$ROOT" --out "$OUT" --label after
echo ""
echo "screenshots in $OUT"
