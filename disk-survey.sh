#!/bin/bash
# Read-only disk audit for a shack Mac: says where the space actually went,
# in the order worth looking. Changes nothing — pair with reclaim-disk.sh.
#
# Written 2026-10-23, when the volume hit 92% and the suspected culprit (a
# 1 GB vendor app) turned out to be 0.7% of the problem while 67 GB sat in
# cargo/CMake build trees. Measure before deleting.

set -u
PROJECTS="${PROJECTS:-$HOME/projects}"
hdr() { printf '\n== %s ==\n' "$1"; }

hdr "Volume"
df -h /System/Volumes/Data | tail -1
diskutil apfs list 2>/dev/null | grep -A3 "$(df /System/Volumes/Data | tail -1 | awk '{print $1}' | sed 's|/dev/||')" \
  | grep "Capacity Consumed"

hdr "Local Time Machine snapshots"
n=$(tmutil listlocalsnapshots / 2>/dev/null | grep -c TimeMachine)
echo "$n snapshot(s)"
# This is the trap. df's "used" includes blocks that only the snapshots still
# reference, so a big delete can free ~nothing until they age out. If the sum
# of the directory sizes below falls well short of df's used figure, the gap
# is almost certainly snapshot-pinned.
[ "${n:-0}" -gt 0 ] && cat <<'TXT'
  NOTE: deletions will not show up in df until these expire (~24h) or are
  dropped with:  sudo tmutil deletelocalsnapshots /
  That costs only local hourly rollback points, not the TM destination.
TXT

hdr "Home, top level"
du -sh "$HOME"/*/ 2>/dev/null | sort -h | tail -12

hdr "Outside home"
# du -x does NOT reliably stay on one filesystem here: macOS firmlinks make
# /System appear to contain the whole data volume, so that line is a
# double-count and should be ignored. /Users is the real one.
du -sh -x /Applications /Library /opt /private /usr 2>/dev/null | sort -h

hdr "Projects, largest first"
du -sh "$PROJECTS"/*/ 2>/dev/null | sort -h | tail -12

hdr "Build output under $PROJECTS (the usual answer)"
find "$PROJECTS" -maxdepth 4 \( -name target -o -name node_modules -o -name .pio -o -name build -o -name DerivedData \) \
     -type d -prune 2>/dev/null | while read -r d; do du -sh "$d" 2>/dev/null; done | sort -h | tail -20

hdr "Caches and toolchains"
du -sh "$HOME/Library/Caches" "$HOME/Library/Developer" "$HOME/Library/Application Support" \
       "$HOME/.cargo" "$HOME/.rustup" "$HOME/.npm" "$HOME/go/pkg" /private/tmp/claude-* 2>/dev/null | sort -h
echo "-- biggest inside Library/Caches --"
du -sh "$HOME/Library/Caches"/* 2>/dev/null | sort -h | tail -6

hdr "Reminders before deleting anything"
cat <<'TXT'
  * Verify with `git check-ignore -q` that a build dir really is ignored.
    Not all are: MSHV-Mac/MSHV/build and meridian/build are source.
  * Release deliverables hide in build trees. dxca/target/win-bundle held
    five Windows zips; they were only safe to delete because the same
    filenames are published as GitHub release assets. Check with
    `gh release view <tag> --json assets`.
  * Never clear ~/Library/Caches wholesale. restic's cache lived there once
    and the cleaner app Mole wiped it mid-seed on 2026-10-22, killing an
    off-site run at 92% (restic/README.md "restic's cache on the Mac").
    It now lives in ~/.cache/restic, but clear named subdirs only.
  * Leave alone: /opt/homebrew (installed packages, not cache), ~/.rustup
    (toolchains), ~/Music, Claude's vm_bundles.
TXT
