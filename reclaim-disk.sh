#!/bin/bash
# Reclaim disk on a shack Mac: gitignored build trees under ~/projects, plus
# the safe toolchain caches. Dry-run unless --apply is passed.
#
# The catch that makes this script necessary: deleting files frees almost
# nothing until the local Time Machine snapshots that pin the blocks are
# dropped. See the tail of this script.
#
# Written 2026-10-23, when the volume sat at 92% and 67 GB of the 85.6 GB
# recovered turned out to be cargo/CMake build output.

set -u
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
PROJECTS="${PROJECTS:-$HOME/projects}"
freed=0

kb()    { du -sk "$1" 2>/dev/null | awk '{print $1}'; }
human() { awk -v k="$1" 'BEGIN{ if(k>1048576) printf "%.1f G", k/1048576; else if(k>1024) printf "%.0f M", k/1024; else printf "%d K", k }'; }
note()  { printf '%-50s %8s  %s\n' "$1" "$2" "$3"; }

[ "$APPLY" = 1 ] || echo "DRY RUN — nothing will be deleted. Re-run with --apply."
echo
echo "## Build trees under $PROJECTS (gitignored only)"

# Only ever delete a build dir git itself agrees is ignored. This guard is the
# whole point: it caught MSHV-Mac/MSHV/build, which is NOT ignored.
while IFS= read -r d; do
  [ -d "$d" ] || continue
  repo=$(cd "$d" && git rev-parse --show-toplevel 2>/dev/null) || continue
  [ -n "$repo" ] || { note "${d#$PROJECTS/}" "-" "SKIP: not a git repo"; continue; }
  rel=${d#"$repo"/}
  if ! (cd "$repo" && git check-ignore -q "$rel" 2>/dev/null); then
    note "${repo##*/}/$rel" "-" "SKIP: not gitignored"; continue
  fi
  sz=$(kb "$d"); freed=$((freed+sz))
  if [ "$APPLY" = 1 ]; then
    rm -rf "$d" && note "${repo##*/}/$rel" "$(human "$sz")" "removed" \
                || note "${repo##*/}/$rel" "$(human "$sz")" "FAILED"
  else
    note "${repo##*/}/$rel" "$(human "$sz")" "would remove"
  fi
done < <(find "$PROJECTS" -maxdepth 4 \( -name target -o -name build -o -name .pio \) -type d -prune 2>/dev/null)

# node_modules is deliberately excluded above: it needs a network `npm install`
# to come back and the saving is small. Release deliverables sometimes hide in
# a target/ dir — check `gh release view <tag> --json assets` before trusting
# this script with a repo that builds distributables.

echo
echo "## Caches"
for c in "$HOME/Library/Developer/Xcode/iOS DeviceSupport" \
         "$HOME/Library/Caches/com.spotify.client" \
         "$HOME/Library/Caches/Homebrew" \
         "$HOME/Library/Caches/go-build"; do
  [ -d "$c" ] || continue
  sz=$(kb "$c"); freed=$((freed+sz))
  if [ "$APPLY" = 1 ]; then rm -rf "$c"/* 2>/dev/null; note "${c#$HOME/}" "$(human "$sz")" "cleared"
  else note "${c#$HOME/}" "$(human "$sz")" "would clear"; fi
done
if [ "$APPLY" = 1 ] && command -v npm >/dev/null 2>&1; then
  before=$(kb "$HOME/.npm"); npm cache clean --force >/dev/null 2>&1
  d=$((before-$(kb "$HOME/.npm"))); freed=$((freed+d)); note ".npm" "$(human "$d")" "cleaned"
fi

echo
echo "TOTAL: $(human "$freed")"
echo
# Not touched on purpose: ~/.rustup (toolchains), ~/Music, /opt/homebrew
# (installed packages, not cache), Claude's vm_bundles, CoreSimulator.

n=$(tmutil listlocalsnapshots / 2>/dev/null | grep -c TimeMachine)
if [ "${n:-0}" -gt 0 ]; then
  echo "NOTE: $n local Time Machine snapshots still pin the freed blocks, so df"
  echo "      will barely move. macOS thins them within ~24h, or release now with:"
  echo "        sudo tmutil deletelocalsnapshots /"
  echo "      That costs only local hourly rollback points, not the TM destination."
  echo "      Verify with: diskutil apfs list | grep 'Capacity Consumed'"
fi
