#!/usr/bin/env bash
# Apply the dsh-tier-router 0.6.0 per-tier fallback patch to a DSH profile.
#
#   bash apply.sh [--profile /c/Users/Administrator/.dsh/profiles/desktop]
#
# The installed package is pnpm-hoisted: every file is hardlinked into
# C:\Users\Administrator\AppData\Local\pnpm\store\v11\files. Editing it in
# place would rewrite shared store content, so this script installs a fresh
# profile-local copy of the whole package and swaps directories. The old
# directory is removed only after the new one verifies; the edited originals
# are kept inside the new package as <name>.orig-<timestamp>.
#
# The config edit is a targeted replacement of the tier-router block only
# (patch-config.mjs); a timestamped backup is written first.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="/c/Users/Administrator/.dsh/profiles/desktop"
if [ "${1:-}" = "--profile" ]; then
  PROFILE="${2:?--profile needs a path}"
fi
PKG="$PROFILE/node_modules/dsh-tier-router"
CFG="$PROFILE/cordis.patch.yml"
SRC="$HERE/dsh-tier-router"
TS="$(date +%Y%m%d%H%M%S)"
NEW="$PROFILE/node_modules/.dsh-tier-router.new-$TS"
OLD="$PROFILE/node_modules/.dsh-tier-router.pre-patch-$TS"
CFG_BAK="$CFG.orig-$TS"
SUCCESS=0
SWAPPED=0
CHANGED="lib/schema.js lib/router.js lib/models-api.js lib/types/index.d.ts"

fail() { echo "ABORT: $*" >&2; exit 1; }
cleanup() {
  if [ "$SUCCESS" = 1 ]; then
    rm -rf "$OLD"
    return
  fi
  if [ "$SWAPPED" = 1 ] && [ -d "$OLD" ]; then
    rm -rf "$PKG"
    mv "$OLD" "$PKG"
  fi
  if [ -f "$CFG_BAK" ]; then
    cp -a "$CFG_BAK" "$CFG"
  fi
}
trap cleanup EXIT

[ -d "$PKG" ] || fail "package not installed: $PKG"
[ -f "$CFG" ] || fail "profile config not found: $CFG"
[ -d "$SRC" ] || fail "staged package not found: $SRC"
grep -q '"version": "0.6.0"' "$PKG/package.json" || fail "installed package is not 0.6.0"
grep -q '"version": "0.6.0"' "$SRC/package.json" || fail "staged package is not 0.6.0"
[ ! -e "$NEW" ] || fail "staging path already exists: $NEW"
[ ! -e "$OLD" ] || fail "rollback path already exists: $OLD"

echo "== dsh-tier-router 0.6.0 tier fallbacks =="
echo "profile : $PROFILE"
echo "package : $PKG"
echo "stamp   : $TS"
stamp() { stat -c '%n links=%h' "$1"; }
stamp "$PKG/index.js" | sed 's/^/before: /' || true

# 1. Backups: config first, then the original edited files are copied into the
#    new package below (before the swap).
cp -a "$CFG" "$CFG_BAK"
echo "backup  : $CFG_BAK"

# 2. Build a physical profile-local copy of the patched package. cp creates new
#    files, so the new tree is not hardlinked into the pnpm store.
cp -a "$SRC" "$NEW"
for f in $CHANGED; do cp -a "$PKG/$f" "$NEW/$f.orig-$TS"; done
bad_links="$(find "$NEW" -type f -printf '%n\n' | awk '$1 != 1' | wc -l | tr -d ' ')"
[ "$bad_links" = 0 ] || fail "new package still has $bad_links hardlinked files"
[ "$(find "$NEW" -type f | wc -l | tr -d ' ')" -ge 22 ] || fail "new package copy is incomplete"

# 3. Swap directories, keeping the old one until all checks pass.
mv "$PKG" "$OLD"
mv "$NEW" "$PKG"
SWAPPED=1
echo "swapped : $OLD -> $PKG (new files are physical copies)"

# 4. Patch only the tier-router block in cordis.patch.yml.
node "$HERE/patch-config.mjs" "$CFG"

# 5. Verify the installed artifacts.
for f in $CHANGED; do node --check "$PKG/$f" || fail "syntax check failed: $f"; done
node "$HERE/verify-installed.mjs" "$PKG" "$CFG"

SUCCESS=1
echo "applied : yes"
echo "backups : $CFG_BAK and $PKG/lib/*.orig-$TS"
echo "sha256  :"
sha256sum "$PKG/lib/schema.js" "$PKG/lib/router.js" "$PKG/lib/models-api.js" "$PKG/lib/types/index.d.ts" "$CFG"
