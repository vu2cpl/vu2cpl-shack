#!/usr/bin/env bash
# Install the weekly restic maintenance job (restic-maint.sh) on the admin workstation.
#
# It belongs on the most trusted machine, because it holds the only credential that can delete backups
# (the NAS rest-server's `maint` login). Normally that's the Mac Mini; the Pi branch exists so it can
# move to an always-on Pi if needed.
#   ./install-maint.sh            auto-detect the platform and confirm
#   ./install-maint.sh macos|pi|linux
#
# macOS: brew install restic (falls back to telling you the manual step), launchd agent
#        com.vu2cpl.restic-maint, Sundays 10:30.
# Pi/Linux: apt install restic, a user crontab line, Sundays 10:30.
# Both: copies the NAS cert to ~/.config/restic/nas.crt and the script to ~/.local/bin/restic-maint.

set -euo pipefail
cd "$(dirname "$0")"

detect() {
    case "$(uname -s)" in
        Darwin) echo macos ;;
        Linux)  grep -qiE 'raspberry pi|bcm27' /proc/cpuinfo 2>/dev/null && echo pi || echo linux ;;
        *)      echo unknown ;;
    esac
}

PLAT=${1:-}
if [ -z "$PLAT" ]; then
    PLAT=$(detect)
    read -r -p "Auto-detected: $PLAT. Is this correct? [Y/n] " a
    case "$a" in [nN]*) read -r -p "Platform (macos / pi / linux): " PLAT ;; esac
fi

if ! command -v restic >/dev/null; then
    case "$PLAT" in
        macos) command -v brew >/dev/null || { echo "Install Homebrew or restic manually (brew install restic), then re-run."; exit 1; }
               brew install restic ;;
        pi|linux) command -v apt-get >/dev/null || { echo "Install restic manually (apt install restic), then re-run."; exit 1; }
               sudo apt-get install -y restic ;;
        *) echo "unsupported platform: $PLAT"; exit 1 ;;
    esac
fi

mkdir -p ~/.config/restic ~/.local/bin ~/.local/state/restic-maint
install -m 644 nas/public.crt ~/.config/restic/nas.crt
install -m 755 restic-maint.sh ~/.local/bin/restic-maint

case "$PLAT" in
    macos)
        PL=~/Library/LaunchAgents/com.vu2cpl.restic-maint.plist
        cat > "$PL" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.vu2cpl.restic-maint</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$HOME/.local/bin/restic-maint</string></array>
  <key>StartCalendarInterval</key><dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>10</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/restic-maint.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/restic-maint.log</string>
</dict></plist>
EOF
        launchctl bootout "gui/$(id -u)" "$PL" 2>/dev/null || true
        launchctl bootstrap "gui/$(id -u)" "$PL"
        echo "launchd agent loaded: com.vu2cpl.restic-maint (Sun 10:30), log ~/Library/Logs/restic-maint.log" ;;
    pi|linux)
        ( crontab -l 2>/dev/null | grep -v restic-maint; echo "30 10 * * 0 $HOME/.local/bin/restic-maint >> $HOME/.local/state/restic-maint/cron.log 2>&1" ) | crontab -
        echo "crontab entry added (Sun 10:30)" ;;
esac
