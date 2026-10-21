#!/usr/bin/env bash
# Install the weekly restic maintenance job (restic-maint.sh) and the nightly copies (restic-copy.sh: to .109's
# HDD as restic-copy, to Google Drive as restic-offsite) on the admin workstation.
#
# It belongs on the most trusted machine, because it holds the only credential that can delete backups
# (the NAS rest-server's `maint` login). Normally that's the Mac Mini; the Pi branch exists so it can
# move to an always-on Pi if needed.
#   ./install-maint.sh            auto-detect the platform and confirm
#   ./install-maint.sh macos|pi|linux
#
# macOS: brew install restic + rclone (falls back to telling you the manual step), launchd agents
#        com.vu2cpl.restic-maint (Sundays 10:30), com.vu2cpl.restic-copy (daily 05:30) and
#        com.vu2cpl.restic-offsite (daily 06:30), all under caffeinate -i so a long run (a first seed) isn't
#        paused by idle sleep.
# Pi/Linux: apt install restic + rclone, user crontab lines at the same times.
# Both: copies the NAS cert to ~/.config/restic/nas.crt and the scripts to ~/.local/bin/restic-{maint,copy,offsite}.
# The Google Drive sign-in is a one-time manual step (rclone remote gdrive-restic; restic/README "Off-site copy").

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

for tool in restic rclone; do
    command -v $tool >/dev/null && continue
    case "$PLAT" in
        macos) command -v brew >/dev/null || { echo "Install Homebrew or $tool manually (brew install $tool), then re-run."; exit 1; }
               brew install $tool ;;
        pi|linux) command -v apt-get >/dev/null || { echo "Install $tool manually (apt install $tool), then re-run."; exit 1; }
               sudo apt-get install -y $tool ;;
        *) echo "unsupported platform: $PLAT"; exit 1 ;;
    esac
done

mkdir -p ~/.config/restic ~/.local/bin ~/.local/state/restic-maint ~/.local/state/restic-copy ~/.local/state/restic-offsite
install -m 644 nas/public.crt ~/.config/restic/nas.crt
install -m 755 restic-maint.sh ~/.local/bin/restic-maint
install -m 755 restic-copy.sh ~/.local/bin/restic-copy
install -m 755 restic-copy.sh ~/.local/bin/restic-offsite

case "$PLAT" in
    macos)
        agent() {   # label calendar-dict-xml
            local PL=~/Library/LaunchAgents/com.vu2cpl.$1.plist
            cat > "$PL" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.vu2cpl.$1</string>
  <key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-i</string><string>/bin/bash</string><string>$HOME/.local/bin/$1</string></array>
  <key>StartCalendarInterval</key><dict>$2</dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/$1.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/$1.log</string>
</dict></plist>
EOF
            launchctl bootout "gui/$(id -u)" "$PL" 2>/dev/null || true
            launchctl bootstrap "gui/$(id -u)" "$PL"
        }
        agent restic-maint '<key>Weekday</key><integer>0</integer><key>Hour</key><integer>10</integer><key>Minute</key><integer>30</integer>'
        agent restic-copy '<key>Hour</key><integer>5</integer><key>Minute</key><integer>30</integer>'
        agent restic-offsite '<key>Hour</key><integer>6</integer><key>Minute</key><integer>30</integer>'
        echo "launchd agents loaded: com.vu2cpl.restic-maint (Sun 10:30), com.vu2cpl.restic-copy (daily 05:30), com.vu2cpl.restic-offsite (daily 06:30); logs ~/Library/Logs/restic-{maint,copy,offsite}.log" ;;
    pi|linux)
        ( crontab -l 2>/dev/null | grep -v -E 'restic-(maint|copy|offsite)'
          echo "30 10 * * 0 $HOME/.local/bin/restic-maint >> $HOME/.local/state/restic-maint/cron.log 2>&1"
          echo "30 5 * * * $HOME/.local/bin/restic-copy >> $HOME/.local/state/restic-copy/cron.log 2>&1"
          echo "30 6 * * * $HOME/.local/bin/restic-offsite >> $HOME/.local/state/restic-offsite/cron.log 2>&1" ) | crontab -
        echo "crontab entries added (maint Sun 10:30, copy daily 05:30, offsite daily 06:30)" ;;
esac
