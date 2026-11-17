#!/usr/bin/env bash
# Re-apply the vu2cpl patches to the HACS Smarteefi integration on HassPi.
#
# Run this from the Mac after ANY HACS update/redownload of Smarteefi - HACS
# replaces the whole component folder and silently drops these patches (it
# happened on 2026-10-02 and nobody noticed for 6 weeks).
#
#   ./apply.sh                 # patch /Volumes/config (Samba share mounted)
#   ./apply.sh --restart       # ...and restart HA (needs HA_TOKEN in ~/.config/vu2cpl-shack.env)
#   ./apply.sh --check         # only report whether the patch is live
#
# The patch is against upstream coreembedded/smarteefi-homeassistant cb9e4c5.
# If upstream changes the same lines, the dry run fails and nothing is touched.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${CONFIG:-/Volumes/config}"
COMP="$CONFIG/custom_components/smarteefi"
MARK="vu2cpl patch: unicast host map"
RESTART=0; CHECK=0
for a in "$@"; do
  case "$a" in
    --restart) RESTART=1 ;;
    --check)   CHECK=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

if [ ! -f "$COMP/__init__.py" ]; then
  echo "Not found: $COMP/__init__.py"
  echo "Mount the HA share first: Finder > Go > Connect to Server > smb://192.168.1.36/config"
  exit 1
fi

if grep -q "$MARK" "$COMP/__init__.py"; then
  echo "Patch is LIVE in $COMP"
  patched=1
else
  echo "Patch is MISSING in $COMP (stock upstream code)"
  patched=0
fi
[ "$CHECK" = 1 ] && exit $((1 - patched))

if [ "$patched" = 0 ]; then
  echo "Dry run..."
  if ! patch -d "$CONFIG" -p1 --dry-run --forward < "$HERE/smarteefi-vu2cpl.patch"; then
    echo "Patch does not apply - upstream changed. Nothing was modified; re-port the patch."
    exit 1
  fi
  stamp="$(date +%Y%m%d-%H%M%S)"
  bak="$CONFIG/smarteefi-backups/$stamp-stock"
  mkdir -p "$bak"
  cp -p "$COMP"/*.py "$COMP/manifest.json" "$bak/"
  echo "Stock files backed up to $bak (outside the component, so HACS keeps them)"
  patch -d "$CONFIG" -p1 --forward --no-backup-if-mismatch < "$HERE/smarteefi-vu2cpl.patch"
  rm -rf "$COMP/__pycache__"
fi

map_changed=0
if ! cmp -s "$HERE/smarteefi_hosts.json" "$CONFIG/smarteefi_hosts.json"; then
  map_changed=1
  if [ -f "$CONFIG/smarteefi_hosts.json" ]; then
    cp -p "$CONFIG/smarteefi_hosts.json" "$CONFIG/smarteefi_hosts.json.bak-$(date +%Y%m%d-%H%M%S)"
  fi
  cp "$HERE/smarteefi_hosts.json" "$CONFIG/smarteefi_hosts.json"
  echo "Host map updated: $CONFIG/smarteefi_hosts.json"
fi

if [ "$RESTART" = 1 ]; then
  set -a; . "$HOME/.config/vu2cpl-shack.env"; set +a
  curl -fsS -m 30 -X POST -H "Authorization: Bearer $HA_TOKEN" \
    http://192.168.1.36:8123/api/services/homeassistant/restart >/dev/null
  echo "HA restart requested (takes ~1-2 min)."
elif [ "$patched" = 0 ]; then
  echo "Now restart HA (a config-entry reload is NOT enough - Python caches the module)."
elif [ "$map_changed" = 1 ]; then
  echo "Map changed only: reload the Smarteefi integration (Settings > Devices & services > Smarteefi > Reload); no restart needed."
fi
