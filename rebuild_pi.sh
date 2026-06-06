#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  rebuild_pi.sh — VU2CPL Shack Pi rebuild script
#
#  Automates ~80 % of the runbook in REBUILD_PI.md. Run on a freshly imaged Pi
#  after first boot + SSH access. Stages match REBUILD_PI.md numbering 1:1.
#
#  Usage:
#     bash rebuild_pi.sh             # run all remaining stages from where left off
#     bash rebuild_pi.sh --reset     # wipe state file and start over
#     bash rebuild_pi.sh --stage N   # run only stage N
#     bash rebuild_pi.sh --status    # print stages completed
#     bash rebuild_pi.sh --help
#
#  State file: $HOME/.rebuild_pi.state — persists across re-runs AND reboots.
#  Idempotent: every stage is safe to re-run.
#
#  Pre-requisites (out of script scope):
#    - Pi OS Lite 64-bit installed (Step 1 of REBUILD_PI.md)
#    - SSH access as a regular (non-root) user. Whatever username and
#      hostname your Pi has is what this script configures the Pi for.
#    - Internet reachable
#
#  See REBUILD_PI.md for the manual fallback procedure.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ═════════════════════════════════════════════════════════════════════════════
# Fork configuration — almost nothing to edit
# ═════════════════════════════════════════════════════════════════════════════
#
# By default this script clones from VU2CPL's upstream repo. If you
# have your own GitHub fork (e.g., because you want to push changes
# back), set REPO_URL to your fork's URL. Otherwise leave it alone —
# `git pull` from upstream forever works fine for personal use.
#
# - REPO_URL:   your fork's HTTPS or SSH URL, or keep VU2CPL's.
# - REPO_NAME:  the directory name under ~/.node-red/projects/.
#               Almost no reason to change this.
#
# **You do NOT need to edit user or hostname.** The script auto-detects
# whatever user you're SSH'd in as (`id -un`) and whatever hostname
# the Pi has (`hostname`). All file paths, sudoers entries, MQTT
# topic prefixes, ssh-key comments, etc. derive from those.
#
# Everything else (apt packages, mosquitto config, Node-RED palette,
# udev rules, file context store, etc.) is generic.
#
# ─────────────────────────────────────────────────────────────────────────────
readonly REPO_URL='https://github.com/vu2cpl/vu2cpl-shack.git'
readonly REPO_NAME='vu2cpl-shack'

# Auto-detected from the actual system — nothing to edit here.
# Used for all file paths, ssh-key comments, chown / chmod, MQTT
# hostname references. Whatever user + hostname you SSH in as is
# the user + hostname this script configures the Pi for.
readonly ACTUAL_USER="$(id -un)"
readonly ACTUAL_HOSTNAME="$(hostname)"
# ═════════════════════════════════════════════════════════════════════════════

# State file lives in $HOME so it survives reboots (Pi reboots during install
# would otherwise wipe /tmp/ and force re-running stages 1-13 from scratch).
readonly STATE_FILE="$HOME/.rebuild_pi.state"
readonly REPO_DIR="$HOME/.node-red/projects/$REPO_NAME"
readonly LP700_DIR="$HOME/LP-700-Server"
readonly ROTATOR_DIR="$HOME/rotator-remote"
readonly SPE_DIR="$HOME/spe-remote"
# Hardware inventory — collected ONCE (see hw_inventory), persisted here, and
# read by every gateway-install stage + Stage 13's dashboard-card patching so
# nothing asks "do you have X?" twice.
readonly HW_FILE="$HOME/.rebuild_pi.hw"

# Stage names (must match the order they execute)
readonly STAGES=(
    "01_apt_packages"
    "02_mosquitto"
    "03_nodered_install"
    "04_nodered_palette"
    "05_settings_js"
    "06_github_ssh"
    "07_clone_repo"
    "08_file_context_store"
    "09_pi_scripts"
    "10_udev_rules"
    "11_lp700_server"
    "12_secrets"
    "13_customize_station"
    "13b_rotator_remote"
    "13c_spe_remote"
    "14_verify"
)

# ─── Helpers ──────────────────────────────────────────────────────────────────

c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
c_blue()   { printf '\033[34m%s\033[0m\n' "$*"; }
c_bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

banner() {
    echo
    c_bold "╔═══════════════════════════════════════════════════════════════════════╗"
    c_bold "║  $(printf '%-69s' "$1")║"
    c_bold "╚═══════════════════════════════════════════════════════════════════════╝"
}

step()  { c_blue "  → $*"; }
ok()    { c_green "  ✓ $*"; }
warn()  { c_yellow "  ⚠ $*"; }
fail()  { c_red "  ✗ $*"; exit 1; }

prompt_continue() {
    echo
    c_yellow "  ⏸  $1"
    read -r -p "      Press Enter to continue (or Ctrl-C to abort)... "
}

# ask_card <var> <prompt> → sets the named global to 1 (yes) or 0 (no).
# Default is Yes (bare Enter). Used by the hardware inventory.
ask_card() {
    local __ans
    read -r -p "  $2 [Y/n] " __ans
    __ans="${__ans:-Y}"
    if [[ "$__ans" =~ ^[Nn] ]]; then printf -v "$1" '0'; else printf -v "$1" '1'; fi
}

stage_done()    { grep -qx "$1" "$STATE_FILE" 2>/dev/null; }
mark_stage()    { mkdir -p "$(dirname "$STATE_FILE")"; echo "$1" >> "$STATE_FILE"; }
unmark_stage()  { sed -i "/^$1$/d" "$STATE_FILE" 2>/dev/null || true; }

# Ensure Node-RED's systemd unit runs as $ACTUAL_USER.
#
# Why this can drift: Pi OS Imager often pre-creates a 'pi' user even when
# you customize the imager for a different username. The Node-RED installer
# may then default to 'pi' instead of the user who actually ran the installer.
# Result: Node-RED runs as 'pi' (writes to /home/pi/.node-red/) while the
# operator works as 'vu2cpl' (with the repo at /home/vu2cpl/.node-red/projects/).
# Stage 5+ then fail because settings.js is in the wrong user's home.
#
# This helper detects the mismatch, installs a systemd drop-in to override
# User= and WorkingDirectory=, and restarts Node-RED. Idempotent — does
# nothing if Node-RED already runs as $ACTUAL_USER.
ensure_nodered_user_matches() {
    local nr_user
    nr_user=$(systemctl show nodered -p User --value 2>/dev/null)
    [[ -z "$nr_user" ]] && return 0   # nodered.service not installed yet — nothing to do
    [[ "$nr_user" == "$ACTUAL_USER" ]] && return 0   # already correct

    warn "Node-RED currently runs as systemd User='$nr_user'"
    warn "but you're running this script as '$ACTUAL_USER'."
    warn "This causes Node-RED to use /home/$nr_user/.node-red/ for its userDir,"
    warn "while everything else this script does lives under /home/$ACTUAL_USER/."
    echo
    c_yellow "  Fix automatically? This will:"
    c_yellow "    1. Stop Node-RED"
    c_yellow "    2. Move /home/$nr_user/.node-red/ to /home/$nr_user/.node-red.bak.<ts>"
    c_yellow "    3. Install systemd drop-in: /etc/systemd/system/nodered.service.d/user.conf"
    c_yellow "       setting User=$ACTUAL_USER, WorkingDirectory=/home/$ACTUAL_USER"
    c_yellow "    4. Restart Node-RED (creates fresh /home/$ACTUAL_USER/.node-red/)"
    echo
    read -r -p "  Proceed? [Y/n] " confirm
    confirm="${confirm:-Y}"
    if [[ ! "$confirm" =~ ^[Yy] ]]; then
        fail "User mismatch unresolved. Fix manually (see SHACK_CHANGELOG) and re-run."
    fi

    step "Stopping Node-RED"
    sudo systemctl stop nodered || true

    if [[ -d "/home/$nr_user/.node-red" ]]; then
        local ts; ts=$(date +%Y%m%d_%H%M%S)
        step "Backing up /home/$nr_user/.node-red -> /home/$nr_user/.node-red.bak.$ts"
        sudo mv "/home/$nr_user/.node-red" "/home/$nr_user/.node-red.bak.$ts"
    fi

    step "Writing systemd drop-in /etc/systemd/system/nodered.service.d/user.conf"
    sudo mkdir -p /etc/systemd/system/nodered.service.d
    sudo tee /etc/systemd/system/nodered.service.d/user.conf > /dev/null <<EOF
[Service]
User=$ACTUAL_USER
WorkingDirectory=/home/$ACTUAL_USER
EOF

    step "Reloading systemd + restarting Node-RED"
    sudo systemctl daemon-reload
    sudo systemctl restart nodered

    step "Waiting up to 60 s for Node-RED to bootstrap userDir as $ACTUAL_USER"
    local waited=0
    while [[ ! -f "/home/$ACTUAL_USER/.node-red/settings.js" ]] && (( waited < 60 )); do
        sleep 3
        waited=$((waited + 3))
    done

    if [[ -f "/home/$ACTUAL_USER/.node-red/settings.js" ]]; then
        ok "Node-RED now runs as $ACTUAL_USER (settings.js bootstrapped)"
    else
        fail "Node-RED restart didn't create /home/$ACTUAL_USER/.node-red/settings.js within 60 s. Check 'sudo journalctl -u nodered -n 50'."
    fi
}

# ─── Pre-flight ───────────────────────────────────────────────────────────────

preflight() {
    banner "Pre-flight checks"

    # Must NOT be root — sudo is requested when needed
    if [[ "$ACTUAL_USER" == 'root' ]]; then
        fail "Don't run this script as root. SSH in as your regular Pi user; sudo is requested when needed."
    fi
    ok "Running as: $ACTUAL_USER"

    # Hostname is informational — auto-detected; whatever it is is what
    # the script configures (MQTT topics, ssh-key comment, etc.).
    ok "Hostname:   $ACTUAL_HOSTNAME"

    # Best-effort Raspberry Pi detection — warn only, don't block
    if ! grep -qiE 'raspberry|bcm27|bcm28' /proc/cpuinfo 2>/dev/null \
       && ! grep -qiE 'raspberry' /proc/device-tree/model 2>/dev/null; then
        warn "This doesn't look like a Raspberry Pi. The script targets Pi OS"
        warn "specifically — apt packages, udev rules, GPIO assumptions, etc."
        warn "may not apply cleanly elsewhere."
        prompt_continue "Continue anyway?"
    else
        ok "Raspberry Pi detected"
    fi

    # Surface the Pi-OS release — surprisingly useful for debugging because
    # several raspi-config subcommands and config-file paths differ between
    # releases (bullseye = /boot/config.txt + do_serial; bookworm/trixie =
    # /boot/firmware/config.txt + do_serial_hw). Showing the codename here
    # makes those mismatches obvious at a glance.
    if [[ -r /etc/os-release ]]; then
        local os_pretty os_codename
        os_pretty=$(grep -E '^PRETTY_NAME=' /etc/os-release | cut -d'"' -f2)
        os_codename=$(grep -E '^VERSION_CODENAME=' /etc/os-release | cut -d= -f2)
        ok "Pi OS:      ${os_pretty:-unknown} (${os_codename:-?})"
        if [[ "$os_codename" == 'bullseye' || "$os_codename" == 'buster' ]]; then
            warn "$os_codename is past Pi OS's current-stable line"
            warn "(current = bookworm or trixie). Most things still work, but a few"
            warn "raspi-config subcommands and boot-config paths differ. The script"
            warn "has fallbacks where it can; you may hit edge cases otherwise."
        fi
    fi

    # Internet — 5 s was too tight for DNS-cold first request on a Pi
    # with slow DNS or WiFi. Try 3 times with 15 s timeout each before
    # giving up. ConnectTimeout separates DNS/connect from full transfer.
    step "Internet reachability check (github.com)"
    local net_attempt=1 net_max=3 net_ok=false
    while (( net_attempt <= net_max )); do
        if curl -sS --max-time 15 --connect-timeout 10 \
                -o /dev/null https://github.com 2>/dev/null; then
            net_ok=true
            break
        fi
        if (( net_attempt < net_max )); then
            warn "Attempt $net_attempt failed — retrying (DNS may need to warm up)"
            sleep 2
        fi
        net_attempt=$((net_attempt + 1))
    done
    if ! $net_ok; then
        c_red "  Diagnostics:"
        c_red "    Default route   : $(ip route show default 2>/dev/null | head -1 | sed 's/^/                      /')"
        c_red "    DNS servers     : $(grep nameserver /etc/resolv.conf 2>/dev/null | head -3 | tr '\n' ' ')"
        c_red "    Direct ping test: $(ping -c1 -W2 github.com 2>&1 | head -2 | tail -1)"
        fail "github.com unreachable after $net_max attempts. Check Wi-Fi/Ethernet, DNS, and any captive-portal interception."
    fi
    ok "Internet reachable (took $net_attempt attempt$([[ $net_attempt -gt 1 ]] && echo s))"

    # Sudo without password? (We'll need it many times.)
    if ! sudo -n true 2>/dev/null; then
        c_yellow "  sudo will prompt for your password during this run."
        sudo true
    fi
    ok "sudo authenticated"

    # Show what's already done
    if [[ -f "$STATE_FILE" ]]; then
        c_yellow "  Resuming — already-completed stages will be skipped:"
        sed 's/^/      /' "$STATE_FILE"
    fi
}

# ─── Stage 1: apt packages + raspi-config ─────────────────────────────────────

stage_01_apt_packages() {
    banner "Stage 1 — apt packages + I²C/UART (REBUILD_PI.md Step 2)"

    step "apt update + dist-upgrade"
    sudo apt update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt -y -qq dist-upgrade

    # If dist-upgrade installed a new kernel, /lib/modules/$(uname -r)/ no
    # longer matches the running kernel — any later `modprobe` (including the
    # i2c-dev step below) will fail with "FATAL: Module … not found". Catch it
    # here, before the operator hits the confusing message, and abort cleanly
    # so they can reboot + resume.
    if [[ -f /var/run/reboot-required ]] || [[ -f /run/reboot-required ]]; then
        c_red "  ✗ Kernel/firmware updated — reboot required before continuing"
        c_yellow "    The dist-upgrade picked up a new kernel. Until you reboot:"
        c_yellow "      • modprobe i2c-dev will return 'FATAL: Module not found'"
        c_yellow "        (running kernel's /lib/modules/ dir is stale)"
        c_yellow "      • dtparam=i2c_arm flip from raspi-config won't take effect"
        c_yellow "      • Other udev-managed devices may misbehave"
        c_yellow "    Recovery:"
        c_yellow "        sudo reboot"
        c_yellow "      After boot:"
        c_yellow "        cd ~/.node-red/projects/vu2cpl-shack"
        c_yellow "        bash rebuild_pi.sh      # resumes Stage 1 (dist-upgrade is idempotent)"
        # Don't mark_stage — we want Stage 1 to replay on resume.
        exit 0
    fi

    step "Install runtime packages"
    sudo apt install -y -qq \
        git \
        mosquitto mosquitto-clients \
        python3 python3-pip python3-venv \
        python3-paho-mqtt python3-rpi.gpio python3-smbus \
        python3-serial \
        i2c-tools \
        build-essential \
        curl jq \
        bash-completion

    step "Enable I²C + hardware UART"
    sudo raspi-config nonint do_i2c 0 \
        || warn "raspi-config do_i2c returned non-zero — may need 'sudo raspi-config' interactive: Interface Options → I²C → Enable"

    # raspi-config's serial-enable subcommand changed names between Pi-OS
    # releases. Bookworm+ exposes do_serial_hw (single-purpose, enables just
    # the hardware UART). Bullseye and earlier use do_serial with a combined
    # 2-bit arg: 0=cons+hw, 1=nothing, 2=hw only, 3=cons only. We try the
    # modern call first; on "not found" fall back to the bullseye form.
    if sudo raspi-config nonint do_serial_hw 0 2>/dev/null; then
        : # bookworm path worked
    elif sudo raspi-config nonint do_serial 2 2>/dev/null; then
        : # bullseye fallback: cons off + hw on
        c_yellow "    (Used bullseye-era 'do_serial 2' fallback — older raspi-config)"
    else
        warn "Could not enable hardware UART non-interactively"
        c_yellow "    Tried both bookworm (do_serial_hw 0) and bullseye (do_serial 2) forms;"
        c_yellow "    neither was recognised. The rotator + SPE amplifier use /dev/ttyAMA0 /"
        c_yellow "    /dev/ttyS0, so without the UART enabled they won't be reachable."
        c_yellow "    Recovery (manual):"
        c_yellow "      sudo raspi-config"
        c_yellow "        → Interface Options → Serial Port"
        c_yellow "        → \"Would you like a login shell over serial?\"  → No"
        c_yellow "        → \"Would you like the serial port hardware to be enabled?\" → Yes"
        c_yellow "        → Finish → reboot"
    fi

    # Some Pi-OS images don't auto-load i2c-dev after raspi-config's dtparam flip;
    # and udev can take a beat to populate /dev/i2c-1 even when it does.
    step "Load i2c-dev module + wait for /dev/i2c-1"
    sudo modprobe i2c-dev 2>/dev/null || true
    i2c_ok=false
    for i in 1 2 3 4 5; do
        if [[ -e /dev/i2c-1 ]]; then
            i2c_ok=true
            break
        fi
        sleep 1
    done

    if $i2c_ok; then
        ok "/dev/i2c-1 present"
    else
        # Downgrade to warn — the AS3935 Pi-side daemon is a standby fallback only;
        # the live publisher since 2026-05-11 is the ESP32 bridge over MQTT, which
        # needs no I²C on this Pi. So a missing /dev/i2c-1 only blocks the Pi-side
        # daemon failover, not normal shack operation.
        warn "/dev/i2c-1 still missing after modprobe + 5 s wait"
        c_yellow "    Diagnostics:"
        c_yellow "      i2c modules loaded : $(lsmod | grep -E '^i2c_' | awk '{print $1}' | tr '\n' ' ')"
        c_yellow "      dtparam in config  : $(grep -E '^dtparam=i2c' /boot/firmware/config.txt 2>/dev/null || grep -E '^dtparam=i2c' /boot/config.txt 2>/dev/null || echo '(not set — raspi-config nonint may have silently no-op'\''d)')"
        c_yellow "      /dev/i2c-* listing : $(ls -1 /dev/i2c-* 2>/dev/null | tr '\n' ' ' || echo '(none)')"
        c_yellow "    Likely cause:"
        c_yellow "      • Brand-new Pi OS image needs a reboot before dtparam takes effect."
        c_yellow "      • Or this Pi has no I²C exposed (rare — fleet-monitor-only Pi)."
        c_yellow "    Impact:"
        c_yellow "      Only affects the LEGACY AS3935 Pi-side daemon (as3935.service)."
        c_yellow "      It is DISABLED by default since the ESP32 bridge took over on"
        c_yellow "      2026-05-11. Normal shack operation is unaffected."
        c_yellow "    Recommended:"
        c_yellow "      Finish this rebuild, then:"
        c_yellow "        sudo reboot       # to apply the dtparam"
        c_yellow "        ls /dev/i2c-1     # re-verify after boot"
        c_yellow "      If still missing, run 'sudo raspi-config' interactively →"
        c_yellow "      Interface Options → I²C → Enable, then reboot."
    fi

    mark_stage "01_apt_packages"
    ok "Stage 1 complete"
}

# ─── Stage 2: Mosquitto LAN config ───────────────────────────────────────────

stage_02_mosquitto() {
    banner "Stage 2 — Mosquitto MQTT broker (REBUILD_PI.md Step 3)"

    step "Install LAN listener config"
    sudo tee /etc/mosquitto/conf.d/lan.conf > /dev/null <<'EOF'
# VU2CPL shack broker — LAN-only, no auth
listener 1883
allow_anonymous true
persistence true
persistence_location /var/lib/mosquitto/
log_dest file /var/log/mosquitto/mosquitto.log
EOF

    step "Enable + start mosquitto"
    sudo systemctl enable --now mosquitto
    sleep 1

    step "Verify mosquitto active"
    systemctl is-active --quiet mosquitto || fail "mosquitto.service not active"
    ok "mosquitto running"

    step "Smoke-test MQTT pub/sub locally"
    timeout 3 mosquitto_sub -h localhost -t '$SYS/#' -C 3 > /dev/null 2>&1 \
        || fail "mosquitto_sub failed — broker may not be listening on localhost:1883"
    ok "Broker accepts subscriptions"

    mark_stage "02_mosquitto"
    ok "Stage 2 complete"
}

# ─── Stage 3: Node-RED install ───────────────────────────────────────────────

stage_03_nodered_install() {
    banner "Stage 3 — Node-RED install (REBUILD_PI.md Step 4)"

    if command -v node-red >/dev/null 2>&1; then
        ok "Node-RED already installed: $(node-red --version 2>&1 | head -1)"
    else
        step "Run official Node-RED installer (this takes ~10 min)"
        c_yellow "  The installer is interactive — answer the prompts:"
        c_yellow "    Are you sure you want to install? → y"
        c_yellow "    Install Pi-specific nodes? → y"
        c_yellow "    Settings.js prompts? → press Enter to accept defaults"
        prompt_continue "Ready to launch the installer?"
        bash <(curl -sL https://raw.githubusercontent.com/node-red/linux-installers/master/deb/update-nodejs-and-nodered)
    fi

    step "Enable + start nodered.service"
    sudo systemctl enable --now nodered
    sleep 5

    # Catch the User= mismatch *before* we verify it's listening on :1880 —
    # if the wrong user owned the install, the helper will recreate the
    # userDir under the correct one.
    ensure_nodered_user_matches

    # Fresh installs on slow SD cards: first-ever Node-RED start can take
    # 30-60 s to bootstrap userDir + parse default flows. The 5-second
    # timeout this used to be is too tight.
    step "Verify Node-RED listening on :1880 (waiting up to 90 s)"
    timeout 90 bash -c 'until curl -sf http://localhost:1880 >/dev/null; do sleep 2; done' \
        || fail "Node-RED not responding on :1880 after 90 s. Check 'sudo journalctl -u nodered -n 50'."
    ok "Node-RED reachable at http://localhost:1880"

    mark_stage "03_nodered_install"
    ok "Stage 3 complete"
}

# ─── Stage 4: Node-RED palette ───────────────────────────────────────────────

stage_04_nodered_palette() {
    banner "Stage 4 — Node-RED palette (REBUILD_PI.md Step 4)"

    cd "$HOME/.node-red"

    local packages=(
        node-red-dashboard            # Dashboard 1 (legacy /ui)
        node-red-contrib-uibuilder    # Vue 3 SPA at /shack — both coexist
        node-red-node-serialport
        node-red-contrib-flexradio
        node-red-contrib-ui-svg
        node-red-node-ping
        node-red-configurable-ping
        node-red-node-rbe
        node-red-contrib-loop
        node-red-contrib-ui-level
    )

    for pkg in "${packages[@]}"; do
        if [[ -d "node_modules/$pkg" ]]; then
            ok "$pkg already installed"
        else
            step "npm install $pkg"
            npm install --no-fund --no-audit --silent "$pkg" || fail "npm install $pkg failed"
        fi
    done

    mark_stage "04_nodered_palette"
    ok "Stage 4 complete"
}

# ─── Stage 5: settings.js — Projects feature ─────────────────────────────────

stage_05_settings_js() {
    banner "Stage 5 — settings.js (Projects feature) (REBUILD_PI.md Step 4)"

    # If Node-RED runs as a different user than the script-runner, fix that
    # first (idempotent — does nothing if already aligned). This catches the
    # very common Pi-OS-Imager scenario where 'pi' was auto-created and the
    # Node-RED installer defaulted to it instead of the operator's actual user.
    ensure_nodered_user_matches

    # Resolve the path Node-RED actually uses. The systemd unit's User=
    # is the source of truth — not necessarily the user running this
    # script. (Post-helper they should now match, but this stays robust.)
    local nr_user nr_home settings
    nr_user=$(systemctl show nodered -p User --value 2>/dev/null)
    nr_user="${nr_user:-$ACTUAL_USER}"
    nr_home=$(getent passwd "$nr_user" | cut -d: -f6)
    nr_home="${nr_home:-$HOME}"
    settings="$nr_home/.node-red/settings.js"

    # If settings.js doesn't exist yet (fresh install — Stage 3's
    # `systemctl enable --now` started Node-RED, but the first-run
    # userDir bootstrap can lag by a few seconds, especially on a
    # slow SD card), wait up to 30 s for it to appear before giving up.
    if [[ ! -f "$settings" ]]; then
        step "settings.js not found at $settings — waiting up to 30 s for Node-RED to bootstrap it"
        # Ensure the service is actually running first
        sudo systemctl restart nodered
        local waited=0
        while [[ ! -f "$settings" ]] && (( waited < 30 )); do
            sleep 2
            waited=$((waited + 2))
        done
    fi

    if [[ ! -f "$settings" ]]; then
        c_red "  Still no $settings after 30 s wait."
        c_red "  Diagnostics:"
        c_red "    systemd User=  : $nr_user"
        c_red "    Home dir       : $nr_home"
        c_red "    Service status : $(systemctl is-active nodered)"
        c_red "    Recent journal :"
        sudo journalctl -u nodered -n 10 --no-pager 2>&1 | sed 's/^/      /'
        fail "settings.js still missing — Node-RED's first-run userDir bootstrap did not happen. Try 'sudo systemctl restart nodered && sleep 30 && ls $settings' manually."
    fi
    ok "settings.js found at $settings (Node-RED user: $nr_user)"

    # Use Node itself to evaluate settings.js — it's just a JS module —
    # and check the current value of editorTheme.projects.enabled. This
    # is more reliable than grep-pattern matching, especially for the
    # nested case where projects can live inside editorTheme: { ... }.
    local projects_state
    projects_state=$(cd "$nr_home/.node-red" 2>/dev/null && \
        node -e 'try { const s = require("./settings.js"); console.log(s.editorTheme && s.editorTheme.projects && s.editorTheme.projects.enabled); } catch(e) { console.log("error:" + e.message); }' 2>&1)

    if [[ "$projects_state" == "true" ]]; then
        ok "Projects feature already enabled (editorTheme.projects.enabled=true)"
    else
        step "Patch settings.js to enable Projects (editorTheme.projects.enabled=true)"
        cp "$settings" "${settings}.bak.$(date +%Y%m%d-%H%M%S)"

        # Node-RED's DEFAULT settings.js already contains a
        # `projects: { ... enabled: false, workflow: { mode: "manual" } }`
        # block nested inside editorTheme. Earlier versions of this stage
        # tried to INSERT new blocks (first at top level, then inside
        # editorTheme at the top) — but JavaScript object-literal
        # "later-key-wins" semantics meant the default block further down
        # always silently overrode our insertion. The fix is *not* to
        # insert anything new — just flip the existing default's
        # `enabled: false` to `enabled: true`.
        #
        # The regex matches any `projects: { ... enabled: false }` block,
        # using `[^}]*?` to ensure `enabled` is inside the SAME projects
        # block (not after it). Multi-flip: if the file has multiple
        # projects: blocks (e.g. leftovers from prior patcher attempts),
        # all are flipped to true. Idempotent — does nothing if every
        # projects: block already says enabled: true.
        python3 <<PYEOF || fail "settings.js patch failed"
import re, sys
path = "$settings"
with open(path) as f:
    txt = f.read()

# Flip any `projects: { ... enabled: false }` to enabled: true. The
# `[^}]*?` non-greedy match ensures we stay inside the same projects
# block (no closing brace allowed before enabled).
pattern = re.compile(r"(projects\s*:\s*\{[^}]*?\benabled\s*:\s*)false\b", re.DOTALL)
new_txt, count = pattern.subn(r"\1true", txt)

if count > 0:
    with open(path, 'w') as f:
        f.write(new_txt)
    print(f"  Flipped {count} projects.enabled false -> true")
else:
    # No existing projects block to flip. Append a top-level editorTheme
    # (last-resort fallback for a heavily customized settings.js).
    fallback = """
    editorTheme: {
        projects: {
            enabled: true,
            workflow: { mode: "manual" }
        }
    },
"""
    new_txt, n = re.subn(r"(\n\}\s*;?\s*)\$", fallback + r"\1", txt)
    if n != 1:
        print("  ERROR: could not locate module.exports closing brace", file=sys.stderr)
        sys.exit(1)
    with open(path, 'w') as f:
        f.write(new_txt)
    print("  No projects block found — appended fallback editorTheme block")
PYEOF

        # Verify Node-RED actually sees enabled=true now
        local verify_state
        verify_state=$(cd "$nr_home/.node-red" 2>/dev/null && \
            node -e 'try { const s = require("./settings.js"); console.log(s.editorTheme && s.editorTheme.projects && s.editorTheme.projects.enabled); } catch(e) { console.log("error:" + e.message); }' 2>&1)
        if [[ "$verify_state" != "true" ]]; then
            fail "settings.js patch applied but editorTheme.projects.enabled is still '$verify_state'. File may have unexpected structure. Manual fix: open $settings and ensure editorTheme.projects.enabled = true at the LAST projects: block."
        fi
        ok "settings.js patched + verified (editorTheme.projects.enabled=true)"
    fi

    # ─── uibuilder.uibRoot — point at the project's uibuilder dir ───
    # uibuilder v7.6.x auto-detects project mode. uibuilder v7.7.x
    # (seen on noderedpi5, 2026-06-03) doesn't — it uses the userDir
    # default (~/.node-red/uibuilder/) which has no /shack source, so
    # /shack returns 404 even though the project is active.
    #
    # Setting uibuilder.uibRoot explicitly in settings.js makes it
    # project-aware regardless of version.
    local uib_state
    uib_state=$(cd "$nr_home/.node-red" 2>/dev/null && \
        node -e 'try { const s = require("./settings.js"); console.log(s.uibuilder && s.uibuilder.uibRoot ? "set" : "unset"); } catch(e) { console.log("error:" + e.message); }' 2>&1)

    if [[ "$uib_state" == "set" ]]; then
        ok "uibuilder.uibRoot already set in settings.js"
    else
        step "Add uibuilder.uibRoot pointing at project ($REPO_NAME)"
        export REBUILD_REPO_NAME="$REPO_NAME"
        export REBUILD_SETTINGS_PATH="$settings"
        python3 <<'PYEOF' || fail "uibuilder.uibRoot patch failed"
import os, re, sys
path = os.environ['REBUILD_SETTINGS_PATH']
repo_name = os.environ['REBUILD_REPO_NAME']

with open(path) as f:
    txt = f.read()

uib_block = f"""
    uibuilder: {{
        uibRoot: __dirname + '/projects/{repo_name}/uibuilder'
    }},
"""

new_txt, n = re.subn(r"(\n\}\s*;?\s*)$", uib_block + r"\1", txt)
if n != 1:
    print("  ERROR: could not locate module.exports closing brace", file=sys.stderr)
    sys.exit(1)

with open(path, 'w') as f:
    f.write(new_txt)
print(f"  Added uibuilder.uibRoot -> projects/{repo_name}/uibuilder")
PYEOF
        unset REBUILD_REPO_NAME REBUILD_SETTINGS_PATH

        # Verify
        local uib_verify
        uib_verify=$(cd "$nr_home/.node-red" 2>/dev/null && \
            node -e 'try { const s = require("./settings.js"); console.log(s.uibuilder && s.uibuilder.uibRoot); } catch(e) { console.log("error:" + e.message); }' 2>&1)
        if [[ "$uib_verify" != *"projects/$REPO_NAME/uibuilder" ]]; then
            fail "uibuilder.uibRoot patch applied but verify returned '$uib_verify'. Expected path ending in projects/$REPO_NAME/uibuilder."
        fi
        ok "uibuilder.uibRoot patched + verified ($uib_verify)"
    fi

    step "Restart Node-RED to pick up the change (waiting up to 60 s)"
    sudo systemctl restart nodered
    sleep 5
    timeout 60 bash -c 'until curl -sf http://localhost:1880 >/dev/null; do sleep 2; done' \
        || fail "Node-RED not responding after restart. Check 'sudo journalctl -u nodered -n 50'."
    ok "Node-RED back up"

    mark_stage "05_settings_js"
    ok "Stage 5 complete"
}

# ─── Stage 6: GitHub SSH key ─────────────────────────────────────────────────

stage_06_github_ssh() {
    banner "Stage 6 — GitHub SSH key (REBUILD_PI.md Step 5)"

    # Optional stage — only needed if you plan to `git push` back to your
    # GitHub fork. Forkers who only `git pull` from upstream can skip this.
    echo
    c_yellow "  This stage sets up a GitHub SSH key for git PUSH operations."
    c_yellow "  If you only plan to git PULL updates from upstream (most forkers),"
    c_yellow "  you can safely skip this stage entirely."
    echo
    local need_push
    read -r -p "  Do you plan to push changes back to GitHub? [y/N] " need_push
    need_push="${need_push:-N}"
    if [[ ! "$need_push" =~ ^[Yy] ]]; then
        ok "Skipping Stage 6 — git pull from upstream works without an SSH key"
        ok "  If you need push later: bash rebuild_pi.sh --stage 6"
        mark_stage "06_github_ssh"
        return 0
    fi

    if [[ ! -f ~/.ssh/id_ed25519 ]]; then
        step "Generate ed25519 keypair"
        ssh-keygen -t ed25519 -C "$ACTUAL_USER@$(hostname)" -f ~/.ssh/id_ed25519 -N ""
    else
        ok "Keypair already exists at ~/.ssh/id_ed25519"
    fi

    show_pubkey() {
        echo
        c_yellow "  ┌─ Add this public key to GitHub: ─────────────────────────────────"
        c_yellow "  │ https://github.com/settings/ssh/new"
        c_yellow "  │ (Title can be anything; paste the line below as the Key:)"
        c_yellow "  │"
        sed 's/^/  │ /' ~/.ssh/id_ed25519.pub
        c_yellow "  │"
        c_yellow "  └──────────────────────────────────────────────────────────────────"
    }

    show_pubkey
    prompt_continue "Once added, hit Enter to verify GitHub access"

    # Retry loop — capture actual SSH output for diagnostics
    local attempt=1 max_attempts=3 ssh_output ssh_status
    while (( attempt <= max_attempts )); do
        step "Test SSH to GitHub (attempt $attempt/$max_attempts)"
        ssh_output=$(ssh -T -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 \
                          git@github.com 2>&1 || true)

        if echo "$ssh_output" | grep -q "successfully authenticated"; then
            local gh_user
            gh_user=$(echo "$ssh_output" | sed -n 's/^Hi \([^!]*\)!.*/\1/p')
            ok "GitHub SSH auth OK (authenticated as GitHub user: $gh_user)"
            mark_stage "06_github_ssh"
            ok "Stage 6 complete"
            return 0
        fi

        # Failure — show what GitHub actually said
        c_red ""
        c_red "  GitHub SSH test failed. Output was:"
        echo "$ssh_output" | sed 's/^/      /' | head -8
        echo
        c_yellow "  Common causes:"
        c_yellow "    1. Pubkey not added yet (or added to the wrong GitHub account)."
        c_yellow "    2. Copy/paste truncated the key — verify the full line is there."
        c_yellow "    3. Network firewall blocking outbound SSH to github.com:22."
        show_pubkey
        echo

        if (( attempt < max_attempts )); then
            local choice
            read -r -p "  [r]etry / [s]kip (git push won't work) / [q]uit ? " choice
            case "$choice" in
                r|R|'') attempt=$((attempt + 1)); continue ;;
                s|S)
                    warn "Skipping Stage 6. git pull will work; git push won't."
                    warn "If you need push later: bash rebuild_pi.sh --stage 6"
                    mark_stage "06_github_ssh"
                    return 0
                    ;;
                q|Q|*) fail "Aborted at Stage 6." ;;
            esac
        else
            fail "GitHub auth failed after $max_attempts attempts. Verify the pubkey is added to the correct GitHub account, then: bash rebuild_pi.sh --stage 6"
        fi
    done
}

# ─── Stage 7: Clone the repo ─────────────────────────────────────────────────

stage_07_clone_repo() {
    banner "Stage 7 — Clone repo into Node-RED projects dir (REBUILD_PI.md Step 5)"

    if [[ -d "$REPO_DIR/.git" ]]; then
        ok "Repo already cloned at $REPO_DIR"
        cd "$REPO_DIR"
        git pull --ff-only || warn "git pull failed — manual merge may be required"
    else
        step "Clone repo"
        mkdir -p "$(dirname "$REPO_DIR")"
        git clone "$REPO_URL" "$REPO_DIR"
    fi

    # Activate the project in Node-RED. Without this file, Node-RED with
    # the Projects feature on (Stage 5) shows an "Open Existing Project /
    # Create New" dialog and NEVER loads the project's flows.json. Result:
    # /ui and /shack 404 even though the repo is cloned and the palette
    # nodes are installed.
    #
    # IMPORTANT: the file is ~/.node-red/.config.projects.json (sibling of
    # settings.js), NOT ~/.node-red/projects/.config.projects.json. The
    # `credentialSecret: false` value tells Node-RED to skip the
    # credentials-encryption-key requirement (otherwise it stops at
    # "credentials encrypted with unknown key" on first load).
    local projects_conf="$HOME/.node-red/.config.projects.json"
    if [[ ! -f "$projects_conf" ]] || ! grep -q "\"activeProject\":\\s*\"$REPO_NAME\"" "$projects_conf"; then
        step "Activate project '$REPO_NAME' in Node-RED"
        cat > "$projects_conf" <<EOF
{
    "projects": {
        "$REPO_NAME": {
            "credentialSecret": false
        }
    },
    "activeProject": "$REPO_NAME"
}
EOF
        # Restart Node-RED so it picks up the active project
        sudo systemctl restart nodered
        sleep 5
        timeout 60 bash -c 'until curl -sf http://localhost:1880 >/dev/null; do sleep 2; done' \
            || warn "Node-RED slow to restart after project activation — check 'sudo journalctl -u nodered -n 50'"
        ok "Project activated; Node-RED restarted"
    else
        ok "Project '$REPO_NAME' already active"
    fi

    if ! grep -q '^nrsave()' ~/.bashrc 2>/dev/null; then
        step "Add nrsave shell function to ~/.bashrc (CLAUDE.md rule #4: regen DXCC tab extract on every flows.json commit)"
        cat >> ~/.bashrc <<'EOF'

# nrsave — regen DXCC tab extract + stage flows.json + commit (CLAUDE.md rule #4)
nrsave() {
    cd "$REPO_DIR" || return 1
    python3 -c 'import json; d=json.load(open("flows.json")); v=[n for n in d if n.get("z")=="d110d176c0aad308" or n.get("id")=="d110d176c0aad308"]; json.dump(v,open("clublog_dxcc_tracker_v7.json","w"),indent=2)' || return 1
    git add flows.json clublog_dxcc_tracker_v7.json
    git commit -m "$1"
}
EOF
    fi

    mark_stage "07_clone_repo"
    ok "Stage 7 complete"
}

# ─── Stage 8: file context store ─────────────────────────────────────────────

stage_08_file_context_store() {
    banner "Stage 8 — Node-RED file context store (REBUILD_PI.md Step 6)"

    if grep -q '"localfilesystem"' ~/.node-red/settings.js 2>/dev/null; then
        ok "File context store already enabled"
    else
        step "Run repo's enable_file_context.sh"
        bash "$REPO_DIR/enable_file_context.sh"
        sudo systemctl restart nodered
        sleep 5
    fi

    mark_stage "08_file_context_store"
    ok "Stage 8 complete"
}

# ─── Stage 9: Pi-side scripts + systemd + sudoers + cron ────────────────────

stage_09_pi_scripts() {
    banner "Stage 9 — Pi-side scripts, systemd units, sudoers, cron (Step 7)"

    cd "$REPO_DIR"

    # User-space scripts
    for f in as3935_mqtt.py as3935_tune.py rpi_agent.py monitor.sh power_spe_on.py; do
        step "Deploy $f"
        sudo cp "$f" "/home/$ACTUAL_USER/$f"
        sudo chown "$ACTUAL_USER":"$ACTUAL_USER" "/home/$ACTUAL_USER/$f"
    done
    sudo chmod +x "/home/$ACTUAL_USER/monitor.sh" "/home/$ACTUAL_USER/as3935_tune.py"

    # Systemd units
    step "Install systemd units"
    sudo cp as3935.service    /etc/systemd/system/as3935.service
    sudo cp rpi-agent.service /etc/systemd/system/rpi-agent.service
    sudo systemctl daemon-reload

    # Sudoers
    step "Install sudoers entry"
    local sudoers_file="/etc/sudoers.d/rpi-agent"
    echo "$ACTUAL_USER ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown" | \
        sudo tee "$sudoers_file" > /dev/null
    sudo chmod 440 "$sudoers_file"

    # Validate ONLY our file. `sudo visudo -c` (no -f) checks the whole
    # /etc/sudoers tree and can fail on pre-existing issues elsewhere
    # (e.g. /etc/sudoers.d/debian_frontend often ships with 644 perms
    # instead of 440 — not our file to fix, but it breaks -c).
    if ! sudo visudo -c -f "$sudoers_file" >/dev/null 2>&1; then
        sudo rm -f "$sudoers_file"
        fail "Our sudoers entry failed validation. ACTUAL_USER='$ACTUAL_USER' — check for special chars."
    fi

    # Detect pre-existing problems elsewhere in /etc/sudoers.d/. Don't
    # fail — those are out of this script's scope to fix automatically
    # (could be system packages we don't own). Just surface them as a
    # warning so the operator knows.
    local other_visudo
    other_visudo=$(sudo visudo -c 2>&1 || true)
    if echo "$other_visudo" | grep -qE "bad permissions|parse error|syntax error" \
       && ! echo "$other_visudo" | grep -qE "$sudoers_file"; then
        echo
        warn "Pre-existing issues in /etc/sudoers.d/ detected (not from this script):"
        echo "$other_visudo" | grep -E "bad permissions|parse error|syntax error" \
            | sed 's/^/      /'
        warn "Common fix for 'bad permissions': sudo chmod 440 /etc/sudoers.d/<filename>"
        warn "Our rpi-agent file is fine. Continuing — but fix those separately."
        echo
    fi

    # Crontab — handle fresh Pi (no existing crontab) gracefully.
    # `crontab -l` exits 1 when no crontab exists; under set -e + pipefail
    # this kills the script silently. Capture the current crontab (or
    # empty), filter out any prior monitor.sh entry, append ours, install.
    step "Schedule monitor.sh in user crontab"
    local existing_cron
    existing_cron=$(crontab -l 2>/dev/null || true)
    {
        echo "$existing_cron" | grep -v 'monitor.sh' || true
        echo "* * * * *  /home/$ACTUAL_USER/monitor.sh"
    } | crontab -

    # Enable + start rpi-agent only.
    # as3935.service is intentionally NOT enabled — the ESP32 bridge
    # (vu2cpl-as3935-bridge repo) is the canonical publisher to
    # lightning/as3935/*. The Pi unit stays installed-but-disabled as a
    # fallback: `sudo systemctl enable --now as3935` resurrects it if
    # the ESP32 ever fails. Enabling both at once races the MQTT topic.
    step "Enable + start rpi-agent service (as3935 stays installed-but-disabled)"
    sudo systemctl enable --now rpi-agent
    sleep 2
    systemctl is-active --quiet rpi-agent || warn "rpi-agent not active — check journalctl -u rpi-agent"

    step "Smoke-test telemetry publishes"
    if timeout 5 mosquitto_sub -h localhost -t "rpi/$(hostname)/cpu" -C 1 >/dev/null 2>&1; then
        ok "Telemetry topic seen on broker"
    else
        warn "No telemetry yet — wait 60 s for first cron tick, then re-check"
    fi

    mark_stage "09_pi_scripts"
    ok "Stage 9 complete"
}

# ─── Stage 10: udev rules ────────────────────────────────────────────────────

stage_10_udev_rules() {
    banner "Stage 10 — udev rules for Telepost / LP-700 (REBUILD_PI.md Step 8)"

    step "Install Telepost udev rule"
    sudo tee /etc/udev/rules.d/10-telepost.rules > /dev/null <<'EOF'
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="04d8", ATTRS{idProduct}=="0001", \
    GROUP="telepost", MODE="0660"
EOF
    sudo groupadd -f telepost
    sudo usermod -aG telepost "$ACTUAL_USER"
    sudo udevadm control --reload-rules
    sudo udevadm trigger
    ok "udev rules reloaded"

    step "Confirm USB serial paths if hardware is plugged in"
    if ls /dev/serial/by-id/ 2>/dev/null | grep -qE 'FT232R|FTDI'; then
        ls -la /dev/serial/by-id/ | grep -E 'FT232R|FTDI' | sed 's/^/      /'
    else
        warn "No FTDI USB serial devices visible — connect SPE / Rotator cables and re-run if needed"
    fi

    mark_stage "10_udev_rules"
    ok "Stage 10 complete"
}

# ─── Stage 11: lp700-server ──────────────────────────────────────────────────

stage_11_lp700_server() {
    banner "Stage 11 — lp700-server gateway (REBUILD_PI.md Step 9)"

    # Already running? Done.
    if systemctl is-active --quiet lp700-server 2>/dev/null; then
        ok "lp700-server already active"
        mark_stage "11_lp700_server"
        return 0
    fi

    # Driven by the hardware inventory — no re-prompt.
    if [[ "${HW_LP700:-1}" != '1' ]]; then
        ok "Skipping Stage 11 — no LP-700 (per hardware inventory)"
        mark_stage "11_lp700_server"
        return 0
    fi
    c_yellow "  lp700-server — WebSocket gateway for the Telepost LP-700 / LP-500."

    # Clone (or detect existing)
    if [[ ! -d "$LP700_DIR" ]]; then
        step "Clone VU3ESV/LP-700-Server"
        git clone https://github.com/VU3ESV/LP-700-Server.git "$LP700_DIR"
    else
        ok "Repo already present at $LP700_DIR — pulling latest"
        (cd "$LP700_DIR" && git pull --ff-only) || warn "git pull failed; continuing with current checkout"
    fi

    cd "$LP700_DIR"

    # Detect architecture and map to the release's binary suffix.
    # Release v0.2.1+ ships: linux-arm64 (Pi 3/4/5 + 64-bit OS),
    # linux-armv7 (Pi Zero/1 + 32-bit OS, also works for ARMv6).
    local arch_suffix
    case "$(uname -m)" in
        aarch64|arm64)        arch_suffix="linux-arm64" ;;
        armv7l|armv6l|armhf)  arch_suffix="linux-armv7" ;;
        *)
            warn "Unsupported architecture: $(uname -m). Skipping lp700-server."
            mark_stage "11_lp700_server"
            return 0
            ;;
    esac

    # Pull the binary URL out of the latest release's asset list.
    step "Locating $arch_suffix binary in latest release"
    local release_url
    release_url=$(curl -sS --max-time 15 \
        "https://api.github.com/repos/VU3ESV/LP-700-Server/releases/latest" 2>/dev/null \
        | grep -oE "https://[^\"]*lp700-server-$arch_suffix" | head -1)
    if [[ -z "$release_url" ]]; then
        fail "Could not find lp700-server-$arch_suffix in latest release. The repo may have restructured again — check https://github.com/VU3ESV/LP-700-Server/releases manually."
    fi
    ok "Found: $release_url"

    step "Downloading binary -> dist/lp700-server-$arch_suffix"
    mkdir -p dist
    curl -sSL --max-time 60 -o "dist/lp700-server-$arch_suffix" "$release_url" \
        || fail "Download failed. Check connectivity to github.com."
    chmod +x "dist/lp700-server-$arch_suffix"
    ok "Binary downloaded ($(du -h "dist/lp700-server-$arch_suffix" | cut -f1))"

    # install.sh creates the 'lp700' user, installs the binary +
    # config.toml + systemd unit + udev rule, reloads systemd + udev,
    # and enables/starts the service.
    step "Running deploy/install.sh (creates user, installs systemd unit, starts service)"
    sudo ./deploy/install.sh || fail "deploy/install.sh failed — check the output above."

    step "Verify /healthz (waiting up to 30 s)"
    local hz_ok=false hz_waited=0
    while (( hz_waited < 30 )); do
        if curl -sf --max-time 3 http://localhost:8089/healthz >/dev/null; then
            hz_ok=true
            break
        fi
        sleep 2
        hz_waited=$((hz_waited + 2))
    done

    if $hz_ok; then
        ok "lp700-server /healthz responds"
    else
        warn "lp700-server /healthz not responding after 30 s."
        warn "  Check: sudo journalctl -u lp700-server -n 30"
        warn "  Common cause: no LP-700 connected yet (the service starts but"
        warn "  the meter isn't reachable). Connect the meter via USB, then"
        warn "  'sudo systemctl restart lp700-server'."
    fi

    mark_stage "11_lp700_server"
    ok "Stage 11 complete"
}

# ─── Stage 12: secrets ───────────────────────────────────────────────────────

stage_12_secrets() {
    banner "Stage 12 — Club Log + Telegram secrets via systemd (Step 10)"

    local secrets_file=/etc/systemd/system/nodered.service.d/secrets.conf

    if sudo test -f "$secrets_file"; then
        ok "$secrets_file already exists — skipping (edit manually if rotation needed)"
    else
        echo
        c_yellow "  Paste the values when prompted. They will NOT echo to screen."
        echo
        local cl_apikey cl_password tg_token
        read -r -s -p "  Club Log API key:  " cl_apikey  ; echo
        read -r -s -p "  Club Log password: " cl_password ; echo
        read -r -s -p "  Telegram bot token: " tg_token  ; echo

        step "Write systemd drop-in"
        sudo mkdir -p "$(dirname "$secrets_file")"
        sudo tee "$secrets_file" > /dev/null <<EOF
[Service]
Environment="CLUBLOG_API_KEY=${cl_apikey}"
Environment="CLUBLOG_PASSWORD=${cl_password}"
Environment="TELEGRAM_TOKEN=${tg_token}"
EOF
        sudo chmod 600 "$secrets_file"
        sudo chown root:root "$secrets_file"
        sudo systemctl daemon-reload
        sudo systemctl restart nodered
        sleep 5
        ok "Secrets written + Node-RED restarted"
    fi

    mark_stage "12_secrets"
    ok "Stage 12 complete"
}

# ─── Stage 13: station customization (Init Defaults + TopBar) ───────────────
#
# Closes the "now edit Init Defaults via the editor and TopBar via SSH"
# gap that forkers stumbled on (FORK_GUIDE Part A5). Prompts for callsign,
# grid, MQTT broker, Tasmota antenna topic + channel, threshold + reconnect
# timer. Patches flows.json (Init Defaults node) and uibuilder/shack/src/
# index.js (TopBar) in-place. Idempotent: re-detects VU2CPL defaults; if
# callsign is already non-VU2CPL, skips with a notice (re-run with
# --stage 13 to change values later).

stage_13_customize_station() {
    banner "Stage 13 — Station customization (Init Defaults + TopBar)"

    cd "$REPO_DIR" || fail "REPO_DIR not found"

    # Detect if already customised — read current CALLSIGN from Init Defaults
    local current_callsign
    current_callsign=$(python3 - <<'PYEOF' 2>/dev/null
import json, re
try:
    d = json.load(open('flows.json'))
    init = next((n for n in d if n.get('id')=='ec1fd4dece8c4dc0'), None)
    if init:
        m = re.search(r"const CALLSIGN\s*=\s*'([^']+)'", init.get('func',''))
        print(m.group(1) if m else '')
except Exception:
    pass
PYEOF
)

    # ALWAYS prompt when this stage runs. The state-file marker handles
    # the "skip already-done in the main pipeline" case automatically.
    # When the operator invokes --stage 13 explicitly, the marker is
    # removed by main(), the stage runs, and we prompt here — they
    # clearly want to change values.
    #
    # We display the current callsign so the operator knows the current
    # state. Default answer is N (skip) so a quick Enter keeps things
    # as they are; pressing y proceeds to the full prompt sequence.

    echo
    if [[ "$current_callsign" != 'VU2CPL' && -n "$current_callsign" ]]; then
        c_yellow "  Init Defaults currently has callsign=$current_callsign"
        c_yellow "  (already customized from upstream's VU2CPL)."
    else
        c_yellow "  Init Defaults currently has upstream defaults"
        c_yellow "  (callsign=VU2CPL, broker=192.168.1.169, etc.)."
    fi
    echo
    c_yellow "  This stage patches station identity into flows.json (Init"
    c_yellow "  Defaults) and the Vue dashboard TopBar:"
    c_yellow "    callsign, grid, MQTT broker IP, Tasmota antenna topic,"
    c_yellow "    POWER channel, disconnect threshold, reconnect timer, QTH."
    echo
    c_yellow "  Press y to re-customize (or to customize from defaults)."
    c_yellow "  Press Enter to keep current values."
    echo
    local proceed
    read -r -p "  (Re-)customize station identity for this Pi? [y/N] " proceed
    proceed="${proceed:-N}"
    if [[ ! "$proceed" =~ ^[Yy] ]]; then
        ok "Skipped — keeping current values"
        ok "  Re-run later with: bash rebuild_pi.sh --stage 13"
        mark_stage "13_customize_station"
        return 0
    fi

    echo
    c_yellow "  Tell the system about YOUR station. This patches Init Defaults"
    c_yellow "  in flows.json + the Vue TopBar. Press Ctrl+C to abort."
    echo

    local callsign grid mqtt_ip power_strip power_ch threshold_km reconnect_min qth_text

    # Callsign — alphanumeric + /, 3-10 chars, force uppercase
    while true; do
        read -r -p "  Callsign (e.g. K1ABC):                                  " callsign
        callsign=$(echo "$callsign" | tr '[:lower:]' '[:upper:]')
        if [[ "$callsign" =~ ^[A-Z0-9/]{3,10}$ ]]; then break; fi
        c_red "    Invalid — alphanumeric + slash, 3-10 chars"
    done

    # Grid — Maidenhead 6-char (letters A-R, digits 0-9, subsquare A-X)
    while true; do
        read -r -p "  6-char Maidenhead grid (e.g. FN42aa):                    " grid
        grid=$(echo "$grid" | sed -E 's/^(..)/\U\1/; s/(..)$/\L\1/')
        if [[ "$grid" =~ ^[A-R][A-R][0-9][0-9][a-x][a-x]$ ]]; then break; fi
        c_red "    Invalid grid — must be 6-char Maidenhead (e.g. FN42aa, MK83te)"
    done

    # MQTT broker IP — default to Pi's own LAN IP
    local default_ip
    default_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    while true; do
        read -r -p "  MQTT broker IP (default ${default_ip:-192.168.1.100}): " mqtt_ip
        mqtt_ip="${mqtt_ip:-${default_ip:-192.168.1.100}}"
        if [[ "$mqtt_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then break; fi
        c_red "    Invalid IP — must be dotted-quad (e.g. 192.168.1.100)"
    done

    # Tasmota antenna power-strip topic
    while true; do
        read -r -p "  Tasmota antenna power-strip topic (default powerstrip1): " power_strip
        power_strip="${power_strip:-powerstrip1}"
        if [[ "$power_strip" =~ ^[a-zA-Z0-9_-]+$ ]]; then break; fi
        c_red "    Invalid topic — alphanumeric, dashes, underscores only"
    done

    # Antenna POWER channel
    while true; do
        read -r -p "  Antenna POWER channel (POWER1..POWER5, default POWER5):  " power_ch
        power_ch="${power_ch:-POWER5}"
        power_ch=$(echo "$power_ch" | tr '[:lower:]' '[:upper:]')
        if [[ "$power_ch" =~ ^POWER[1-5]$ ]]; then break; fi
        c_red "    Invalid — must be POWER1..POWER5"
    done

    # Distance / timer with defaults
    while true; do
        read -r -p "  Disconnect threshold km (default 40):                   " threshold_km
        threshold_km="${threshold_km:-40}"
        if [[ "$threshold_km" =~ ^[0-9]+$ ]] && (( threshold_km > 0 && threshold_km < 200 )); then break; fi
        c_red "    Invalid — positive integer < 200"
    done

    while true; do
        read -r -p "  Reconnect timer minutes (default 20):                   " reconnect_min
        reconnect_min="${reconnect_min:-20}"
        if [[ "$reconnect_min" =~ ^[0-9]+$ ]] && (( reconnect_min > 0 && reconnect_min < 240 )); then break; fi
        c_red "    Invalid — positive integer < 240"
    done

    # QTH text (free-form, for TopBar sub line)
    read -r -p "  QTH location text for header (e.g. 'New York · USA'):     " qth_text
    qth_text="${qth_text:-Your QTH}"

    # Which dashboard cards to show comes from the hardware inventory (asked
    # once at the start of the run, see hw_inventory). The HW_* globals are
    # already set — we just apply them to the Vue CARDS flags + the safe-subset
    # flow-tab disables below. No re-prompting here.

    echo
    c_yellow "  Summary:"
    echo "    Callsign:           $callsign"
    echo "    Grid:               $grid"
    echo "    MQTT broker:        $mqtt_ip"
    echo "    Antenna topic:      $power_strip / $power_ch"
    echo "    Threshold / timer:  ${threshold_km}km / ${reconnect_min}min"
    echo "    QTH text:           $qth_text"
    local enabled_list="" disabled_list="" pair
    for pair in "FlexRadio:$HW_FLEX" "SPE:$HW_SPE" "LP-700:$HW_LP700" \
                "Rotator:$HW_ROTATOR" "Lightning:$HW_LIGHTNING" "Power:$HW_POWER" \
                "Solar:$HW_SOLAR" "DXCC:$HW_DXCC" "RBN:$HW_RBN" \
                "RPi:$HW_RPI" "Network:$HW_NETWORK" "GPS-NTP:$HW_GPSNTP"; do
        if [[ "${pair#*:}" == '1' ]]; then enabled_list+="${pair%:*} "; else disabled_list+="${pair%:*} "; fi
    done
    echo "    Cards ON (from inventory):  ${enabled_list:-(none)}"
    echo "    Cards OFF (from inventory): ${disabled_list:-(none)}"
    echo
    local confirm
    read -r -p "  Patch files with these values? [Y/n] " confirm
    confirm="${confirm:-Y}"
    if [[ ! "$confirm" =~ ^[Yy] ]]; then
        c_yellow "  Skipped. Run --stage 13 again when ready."
        return 1
    fi

    # Backup before patching
    local ts
    ts=$(date +%Y%m%d_%H%M%S)
    step "Backing up flows.json -> flows.json.bak.${ts}"
    cp flows.json "flows.json.bak.${ts}"
    step "Backing up index.js -> index.js.bak.${ts}"
    cp uibuilder/shack/src/index.js "uibuilder/shack/src/index.js.bak.${ts}"

    # Patch flows.json (Init Defaults) — export vars for Python heredoc
    export PATCH_CALLSIGN="$callsign"
    export PATCH_GRID="$grid"
    export PATCH_MQTT="$mqtt_ip"
    export PATCH_STRIP="$power_strip"
    export PATCH_CH="$power_ch"
    export PATCH_THRESHOLD="$threshold_km"
    export PATCH_RECONNECT="$reconnect_min"
    export PATCH_QTH="$qth_text"
    # Card visibility comes from the hardware inventory (HW_* globals).
    export PATCH_HW_FLEX="$HW_FLEX" PATCH_HW_SPE="$HW_SPE" PATCH_HW_LP700="$HW_LP700"
    export PATCH_HW_ROTATOR="$HW_ROTATOR" PATCH_HW_LIGHTNING="$HW_LIGHTNING" PATCH_HW_POWER="$HW_POWER"
    export PATCH_HW_SOLAR="$HW_SOLAR" PATCH_HW_DXCC="$HW_DXCC" PATCH_HW_RBN="$HW_RBN"
    export PATCH_HW_RPI="$HW_RPI" PATCH_HW_NETWORK="$HW_NETWORK" PATCH_HW_GPSNTP="$HW_GPSNTP"

    step "Patching flows.json Init Defaults"
    python3 - <<'PYEOF' || fail "flows.json patch failed"
import json, os, re, sys
CALLSIGN  = os.environ['PATCH_CALLSIGN']
GRID      = os.environ['PATCH_GRID']
MQTT      = os.environ['PATCH_MQTT']
STRIP     = os.environ['PATCH_STRIP']
CH        = os.environ['PATCH_CH']
THRESHOLD = os.environ['PATCH_THRESHOLD']
RECONNECT = os.environ['PATCH_RECONNECT']

with open('flows.json') as f:
    d = json.load(f)
init = next((n for n in d if n.get('id') == 'ec1fd4dece8c4dc0'), None)
if not init:
    print('ERROR: Init Defaults node (ec1fd4dece8c4dc0) not found', file=sys.stderr)
    sys.exit(1)

func = init['func']
patches = [
    (r"const MQTT_BROKER\s*=\s*'[^']*'",   f"const MQTT_BROKER = '{MQTT}'"),
    (r"const CALLSIGN\s*=\s*'[^']*'",      f"const CALLSIGN    = '{CALLSIGN}'"),
    (r"const GRID_SQUARE\s*=\s*'[^']*'",   f"const GRID_SQUARE = '{GRID}'"),
    (r"const POWER_STRIP\s*=\s*'[^']*'",   f"const POWER_STRIP = '{STRIP}'"),
    (r"const POWER_CH\s*=\s*'[^']*'",      f"const POWER_CH    = '{CH}'"),
    (r"const THRESHOLD_KM\s*=\s*\d+",      f"const THRESHOLD_KM = {THRESHOLD}"),
    (r"const RECONNECT_MIN\s*=\s*\d+",     f"const RECONNECT_MIN = {RECONNECT}"),
]
for pat, rep in patches:
    func, n = re.subn(pat, rep, func)
    if n != 1:
        print(f'  WARN: pattern matched {n}x (expected 1): {pat}')
init['func'] = func

# ── MQTT broker CONFIG nodes ───────────────────────────────────────────
# The Init Defaults MQTT_BROKER const above is informational only — a
# function node can't reconfigure a broker config node at runtime. The 37
# mqtt-in/out nodes connect via the mqtt-broker CONFIG nodes, whose `broker`
# field is what actually decides where they dial. Patch every mqtt-broker
# config node to the forker's IP, else all mqtt nodes keep dialing the
# upstream Pi and show disconnected ("broker not filled in").
broker_patched = 0
for n in d:
    if n.get('type') == 'mqtt-broker':
        n['broker'] = MQTT
        broker_patched += 1
print(f'  mqtt-broker config nodes patched: {broker_patched}')

# ── D1 safe-subset: disable the flow tab for absent stand-alone hardware ─
# Only the five self-contained, single-subsystem tabs are touched. Setting
# the tab's `disabled` flag removes its /ui card AND stops its background
# polling. Entangled tabs (Flex/Rotator/Lightning/Power/RPi/Network/GPS)
# are NOT touched here — Vue-only hiding for those, because other tabs wire
# into their logic or share a D1 group.
#   env flag '0' (no hardware) → disable the tab; '1' → ensure enabled.
SAFE_TABS = {
    'PATCH_HW_SPE':   'spe_ws_tab_01',          # SPE (WS)
    'PATCH_HW_LP700': '18fb42443172f33c',       # LP-700-HID ws
    'PATCH_HW_SOLAR': '590e889d44815afb',       # Solar
    'PATCH_HW_DXCC':  'd110d176c0aad308',       # DXCC Tracker
    'PATCH_HW_RBN':   'f9a0e3ad0e019052',       # RBN Skimmer Monitor
}
tab_by_id = {n['id']: n for n in d if n.get('type') == 'tab'}
for env_key, tab_id in SAFE_TABS.items():
    want_on = os.environ.get(env_key, '1') == '1'
    tab = tab_by_id.get(tab_id)
    if not tab:
        print(f'  WARN: safe-subset tab {tab_id} ({env_key}) not found')
        continue
    if want_on:
        tab.pop('disabled', None)           # ensure runnable (idempotent re-enable)
    else:
        tab['disabled'] = True
        print(f"  disabled flow tab: {tab.get('label', tab_id)}")

with open('flows.json', 'w') as f:
    json.dump(d, f, indent=4)
print('  flows.json patched')
PYEOF
    ok "flows.json Init Defaults + broker + safe-subset tabs patched"

    step "Patching uibuilder/shack/src/index.js TopBar"
    python3 - <<'PYEOF' || fail "index.js patch failed"
import os, re, sys
CALLSIGN = os.environ['PATCH_CALLSIGN']
GRID     = os.environ['PATCH_GRID']
QTH      = os.environ['PATCH_QTH']

path = 'uibuilder/shack/src/index.js'
with open(path) as f:
    s = f.read()

# Patch TopBar callsign span
s2, n = re.subn(r'<span class="callsign">[^<]*</span>',
                f'<span class="callsign">{CALLSIGN}</span>', s)
if n == 0:
    print('  WARN: TopBar <span class="callsign"> not found — may have moved')
else:
    print(f'  TopBar callsign updated ({n} replacement)')
    s = s2

# Patch sub line (contains grid + city text)
s2, n = re.subn(r'<div class="sub">[^<]*</div>',
                f'<div class="sub">{GRID} · {QTH}</div>', s)
if n == 0:
    print('  WARN: TopBar <div class="sub"> not found — may have moved')
else:
    print(f'  TopBar sub line updated ({n} replacement)')
    s = s2

# ── CARDS hardware flags — hide cards for absent subsystems ─────────────
# Flip booleans inside the `const CARDS = { … };` block only. Scoped to the
# block so the many other `true`/`false` literals in the file are untouched.
# Idempotent: each key is forced to match its flag (re-run flips back too).
HW = {
    'flex':      os.environ.get('PATCH_HW_FLEX', '1'),
    'lp700':     os.environ.get('PATCH_HW_LP700', '1'),
    'spe':       os.environ.get('PATCH_HW_SPE', '1'),
    'rotator':   os.environ.get('PATCH_HW_ROTATOR', '1'),
    'lightning': os.environ.get('PATCH_HW_LIGHTNING', '1'),
    'power':     os.environ.get('PATCH_HW_POWER', '1'),
    'solar':     os.environ.get('PATCH_HW_SOLAR', '1'),
    'dxcc':      os.environ.get('PATCH_HW_DXCC', '1'),
    'rbn':       os.environ.get('PATCH_HW_RBN', '1'),
    'rpi':       os.environ.get('PATCH_HW_RPI', '1'),
    'network':   os.environ.get('PATCH_HW_NETWORK', '1'),
    'gpsntp':    os.environ.get('PATCH_HW_GPSNTP', '1'),
}
m = re.search(r'const CARDS\s*=\s*\{(.*?)\};', s, re.DOTALL)
if not m:
    print('  WARN: const CARDS block not found — cards not patched')
else:
    block = m.group(1)
    for key, val in HW.items():
        boolstr = 'true' if val == '1' else 'false'
        block, n = re.subn(r'(\b' + key + r'\s*:\s*)(?:true|false)',
                           r'\g<1>' + boolstr, block)
        if n != 1:
            print(f'  WARN: CARDS.{key} matched {n}x (expected 1)')
    s = s[:m.start(1)] + block + s[m.end(1):]
    off = [k for k, v in HW.items() if v == '0']
    print(f"  CARDS patched — hidden: {', '.join(off) if off else '(none)'}")

with open(path, 'w') as f:
    f.write(s)
PYEOF
    ok "index.js TopBar + CARDS patched"

    # Optional: patch manifest.json name if it exists
    if [[ -f uibuilder/shack/src/manifest.json ]]; then
        step "Patching manifest.json name"
        python3 - <<PYEOF || true
import json
try:
    with open('uibuilder/shack/src/manifest.json') as f:
        m = json.load(f)
    m['name'] = '${callsign} Shack'
    m['short_name'] = 'Shack'
    with open('uibuilder/shack/src/manifest.json', 'w') as f:
        json.dump(m, f, indent=2)
    print('  manifest.json patched (name=${callsign} Shack)')
except Exception as e:
    print(f'  WARN: manifest.json patch skipped: {e}')
PYEOF
    fi

    unset PATCH_CALLSIGN PATCH_GRID PATCH_MQTT PATCH_STRIP PATCH_CH
    unset PATCH_THRESHOLD PATCH_RECONNECT PATCH_QTH
    unset PATCH_HW_FLEX PATCH_HW_SPE PATCH_HW_LP700 PATCH_HW_ROTATOR
    unset PATCH_HW_LIGHTNING PATCH_HW_POWER PATCH_HW_SOLAR PATCH_HW_DXCC
    unset PATCH_HW_RBN PATCH_HW_RPI PATCH_HW_NETWORK PATCH_HW_GPSNTP

    ok "Backups kept: flows.json.bak.${ts}, index.js.bak.${ts}"
    ok "Run 'sudo systemctl restart nodered' once the install finishes,"
    ok "then hard-refresh /shack to see your station identity."

    mark_stage "13_customize_station"
    ok "Stage 13 complete"
}

# ─── Stage 13b: rotator-remote gateway (optional) ────────────────────────────

stage_13b_rotator_remote() {
    banner "Stage 13b — rotator-remote gateway (optional)"

    # Already running? Done.
    if systemctl is-active --quiet rotator-remote 2>/dev/null; then
        ok "rotator-remote already active"
        mark_stage "13b_rotator_remote"
        return 0
    fi

    # Driven by the hardware inventory — no re-prompt.
    if [[ "${HW_ROTATOR:-1}" != '1' ]]; then
        ok "Skipping Stage 13b — no rotator (per hardware inventory)"
        mark_stage "13b_rotator_remote"
        return 0
    fi
    c_yellow "  rotator-remote — WebSocket gateway for an Idiom Press Rotor-EZ"
    c_yellow "  (DCU-1 compatible) rotator. Owns the FTDI serial port; Node-RED + other"
    c_yellow "  clients share it without contention."

    # Clone (or update).
    if [[ ! -d "$ROTATOR_DIR" ]]; then
        step "Clone vu2cpl/rotator-remote"
        git clone https://github.com/vu2cpl/rotator-remote.git "$ROTATOR_DIR" \
            || fail "Clone failed — check connectivity to github.com."
    else
        ok "Repo already present at $ROTATOR_DIR — pulling latest"
        (cd "$ROTATOR_DIR" && git pull --ff-only) || warn "git pull failed; continuing with current checkout"
    fi
    cd "$ROTATOR_DIR" || fail "Cannot cd to $ROTATOR_DIR"

    # Point config.yaml at this station's rotor serial device.
    echo
    c_yellow "  USB-serial devices on this Pi (/dev/serial/by-id):"
    ls -1 /dev/serial/by-id/ 2>/dev/null | sed 's/^/      /' \
        || c_yellow "      (none found — is the rotor FTDI cable plugged in?)"
    local cur_port rot_port
    cur_port=$(grep -E '^[[:space:]]*port:' config.yaml | head -1 | sed -E 's/^[[:space:]]*port:[[:space:]]*//')
    echo
    read -r -p "  Rotor-EZ serial device path (Enter to keep default): " rot_port
    rot_port="${rot_port:-$cur_port}"
    if [[ -n "$rot_port" && "$rot_port" != "$cur_port" ]]; then
        step "Setting serial.port = $rot_port in config.yaml"
        ROT_PORT="$rot_port" python3 - <<'PYEOF'
import os, re
port = os.environ['ROT_PORT']
t = open('config.yaml').read()
# Replace the first 'port:' (serial.port — the serial block precedes server).
t2, n = re.subn(r'(^[ \t]*port:[ \t]*).*$', r'\g<1>' + port, t, count=1, flags=re.M)
open('config.yaml', 'w').write(t2)
print('  patched' if n == 1 else '  WARN: serial port line not found — edit config.yaml by hand')
PYEOF
    fi

    step "Running setup.sh (venv + deps)"
    ./setup.sh || fail "setup.sh failed — check the output above."

    step "Installing systemd service (sudo ./install-service.sh)"
    sudo ./install-service.sh || fail "install-service.sh failed — check the output above."

    step "Verify /healthz (waiting up to 20 s)"
    local hz_ok=false hz_waited=0
    while (( hz_waited < 20 )); do
        if curl -sf --max-time 3 http://localhost:8090/healthz >/dev/null; then
            hz_ok=true
            break
        fi
        sleep 2
        hz_waited=$((hz_waited + 2))
    done
    if $hz_ok; then
        ok "rotator-remote /healthz responds on :8090"
        c_yellow "  (serial:\"down\" until the rotor controller is powered — normal;"
        c_yellow "   power it on via the dashboard / Tasmota to see a live heading.)"
    else
        warn "rotator-remote /healthz not responding after 20 s."
        warn "  Check: sudo journalctl -u rotator-remote -n 30"
        warn "  Common cause: the serial port is still held by Node-RED. Confirm the"
        warn "  ws-client Rotator flow is deployed (no serial nodes — git pull +"
        warn "  restart nodered), then 'sudo systemctl restart rotator-remote'."
    fi

    mark_stage "13b_rotator_remote"
    ok "Stage 13b complete"
}

# ─── Stage 13c: spe-remote gateway (optional) ────────────────────────────────

stage_13c_spe_remote() {
    banner "Stage 13c — spe-remote gateway (optional)"

    # Already running? Done.
    if systemctl is-active --quiet spe-remote 2>/dev/null; then
        ok "spe-remote already active"
        mark_stage "13c_spe_remote"
        return 0
    fi

    # Driven by the hardware inventory — no re-prompt.
    if [[ "${HW_SPE:-1}" != '1' ]]; then
        ok "Skipping Stage 13c — no SPE amplifier (per hardware inventory)"
        mark_stage "13c_spe_remote"
        return 0
    fi
    c_yellow "  spe-remote — WebSocket gateway for the SPE Expert amplifier. Owns the"
    c_yellow "  SPE FTDI serial port; Node-RED + other clients share it. Also handles"
    c_yellow "  power-on via a DTR/RTS toggle on the open port."

    # Clone (or update).
    if [[ ! -d "$SPE_DIR" ]]; then
        step "Clone vu2cpl/spe-remote"
        git clone https://github.com/vu2cpl/spe-remote.git "$SPE_DIR" \
            || fail "Clone failed — check connectivity to github.com."
    else
        ok "Repo already present at $SPE_DIR — pulling latest"
        (cd "$SPE_DIR" && git pull --ff-only) || warn "git pull failed; continuing with current checkout"
    fi
    cd "$SPE_DIR" || fail "Cannot cd to $SPE_DIR"

    # Point config.yaml at this station's SPE serial device.
    echo
    c_yellow "  USB-serial devices on this Pi (/dev/serial/by-id):"
    ls -1 /dev/serial/by-id/ 2>/dev/null | sed 's/^/      /' \
        || c_yellow "      (none found — is the SPE FTDI cable plugged in?)"
    local cur_port spe_port
    cur_port=$(grep -E '^[[:space:]]*port:' config.yaml | head -1 | sed -E 's/^[[:space:]]*port:[[:space:]]*//')
    echo
    read -r -p "  SPE serial device path (Enter to keep default): " spe_port
    spe_port="${spe_port:-$cur_port}"
    if [[ -n "$spe_port" && "$spe_port" != "$cur_port" ]]; then
        step "Setting serial.port = $spe_port in config.yaml"
        SPE_PORT="$spe_port" python3 - <<'PYEOF'
import os, re
port = os.environ['SPE_PORT']
t = open('config.yaml').read()
# Replace the first 'port:' (serial.port — the serial block precedes server).
t2, n = re.subn(r'(^[ \t]*port:[ \t]*).*$', r'\g<1>' + port, t, count=1, flags=re.M)
open('config.yaml', 'w').write(t2)
print('  patched' if n == 1 else '  WARN: serial port line not found — edit config.yaml by hand')
PYEOF
    fi

    step "Running setup.sh (venv + deps)"
    ./setup.sh || fail "setup.sh failed — check the output above."

    step "Installing systemd service (sudo ./install-service.sh)"
    sudo ./install-service.sh || fail "install-service.sh failed — check the output above."

    # spe-remote has no /healthz; the server serves its bundled dashboard at /,
    # so a 200 on the root means the WS server is up.
    step "Verify server responds on :8888 (waiting up to 20 s)"
    local hz_ok=false hz_waited=0
    while (( hz_waited < 20 )); do
        if curl -sf --max-time 3 http://localhost:8888/ >/dev/null; then
            hz_ok=true
            break
        fi
        sleep 2
        hz_waited=$((hz_waited + 2))
    done
    if $hz_ok; then
        ok "spe-remote responds on :8888"
        c_yellow "  (the amp can be OFF — the gateway still serves; power it on from"
        c_yellow "   the dashboard to see live state.)"
    else
        warn "spe-remote not responding on :8888 after 20 s."
        warn "  Check: sudo journalctl -u spe-remote -n 30"
        warn "  Common cause: the SPE serial port is wrong or already held by"
        warn "  Node-RED. The Node-RED SPE tab is a ws-client, so it should not"
        warn "  hold the port — confirm config.yaml serial.port is correct."
    fi

    mark_stage "13c_spe_remote"
    ok "Stage 13c complete"
}

# ─── Stage 14: verification (matches REBUILD_PI.md Step 12 + #13) ───────────

stage_14_verify() {
    banner "Stage 14 — Final verification (REBUILD_PI.md Step 12)"

    local pass=0 fail=0 skip=0

    # Critical checks: things that MUST work for the dashboards to function.
    # Failure here means the install is incomplete and the operator needs
    # to act (warn-level, not auto-fix from here).
    check_critical() {
        local label="$1" cmd="$2" hint="$3"
        if eval "$cmd" >/dev/null 2>&1; then
            ok "$label"
            ((pass++))
        else
            c_red "  ✗ $label"
            [[ -n "$hint" ]] && c_red "      → $hint"
            ((fail++))
        fi
    }

    # Optional checks: hardware/services that may not be present on this
    # Pi. If they pass, great. If they fail, that's "you don't have it
    # connected yet" — not a script problem.
    check_optional() {
        local label="$1" cmd="$2" not_present_hint="$3"
        if eval "$cmd" >/dev/null 2>&1; then
            ok "$label"
            ((pass++))
        else
            c_yellow "  ⊘ $label (skipped — $not_present_hint)"
            ((skip++))
        fi
    }

    # ─── Core infrastructure ─────────────────────────────────────────
    check_critical "Node-RED editor responds at :1880" \
        "curl -sf --max-time 5 http://localhost:1880" \
        "Service may have failed to start. Check: sudo systemctl status nodered"

    check_critical "Mosquitto broker reachable" \
        "timeout 3 mosquitto_sub -h localhost -t '\$SYS/#' -C 1" \
        "Broker may not be running. Check: sudo systemctl status mosquitto"

    # ─── Project + flows actually loaded (the missing-link checks) ───
    # Note: the file lives at ~/.node-red/.config.projects.json (sibling
    # of settings.js), NOT under ~/.node-red/projects/.
    local projects_conf="$HOME/.node-red/.config.projects.json"
    check_critical "Node-RED project '$REPO_NAME' is active" \
        "[[ -f '$projects_conf' ]] && grep -q '\"activeProject\":\\s*\"$REPO_NAME\"' '$projects_conf'" \
        "Project not activated. Re-run: bash rebuild_pi.sh --stage 7"

    check_critical "Node-RED 'Started flows' in recent log" \
        "sudo journalctl -u nodered --since '5 minutes ago' --no-pager | grep -q 'Started flows'" \
        "Flow file did not parse. Check: sudo journalctl -u nodered -n 100 | grep -iE 'error|unknown type'"

    # ─── Dashboards reachable (the end-user goal) ────────────────────
    # /shack is the canonical Vue dashboard; /ui is the legacy D1 path.
    # Both should respond once flows are loaded. A 200 OR 401 (auth on)
    # counts as up — the endpoint is registered.
    check_critical "Vue dashboard /shack responds (200 or 401)" \
        "curl -sf -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:1880/shack | grep -qE '^(200|401)\$'" \
        "Dashboard not served. Likely flows didn't load. Check journalctl for 'Started flows'."

    check_critical "D1 dashboard /ui responds (200 or 401)" \
        "curl -sf -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:1880/ui | grep -qE '^(200|401)\$'" \
        "D1 dashboard not served. Likely flows didn't load (same root cause as /shack failure)."

    # ─── Pi-side services ────────────────────────────────────────────
    check_critical "rpi-agent.service is active" \
        "systemctl is-active --quiet rpi-agent" \
        "Reboot/shutdown buttons won't work. Check: sudo systemctl status rpi-agent"

    check_optional "rpi/$(hostname) telemetry on broker" \
        "timeout 65 mosquitto_sub -h localhost -t 'rpi/$(hostname)/cpu' -C 1" \
        "monitor.sh cron hasn't fired yet (wait ~60 s after install)"

    # ─── Optional hardware-dependent services ────────────────────────
    # These FAIL silently if the hardware isn't present — that's expected.
    check_optional "lp700-server /healthz" \
        "curl -sf --max-time 3 http://localhost:8089/healthz" \
        "LP-700 not installed (no LP-700 in inventory) or meter not yet connected"

    check_optional "rotator-remote /healthz" \
        "curl -sf --max-time 3 http://localhost:8090/healthz" \
        "rotator not installed (no rotator in inventory) or gateway not running"

    check_optional "spe-remote :8888" \
        "curl -sf --max-time 3 http://localhost:8888/" \
        "SPE not installed (no SPE in inventory) or gateway not running"

    check_optional "lightning/as3935/hb topic" \
        "timeout 35 mosquitto_sub -h localhost -t 'lightning/as3935/hb' -C 1" \
        "ESP32 AS3935 bridge not running or not yet publishing"

    check_optional "shack/gpsntp/chrony topic" \
        "timeout 65 mosquitto_sub -h localhost -t 'shack/gpsntp/chrony' -C 1" \
        "GPS-NTP Pi not running or not publishing telemetry"

    # ─── Summary ─────────────────────────────────────────────────────
    echo
    if [[ $fail -gt 0 ]]; then
        c_red "  $pass pass · $fail FAIL · $skip skipped (optional)"
        c_red "  Install is NOT complete. Address the FAIL items above."
        echo
        c_red "  Common recovery paths:"
        c_red "    'Project not active'   -> bash rebuild_pi.sh --stage 7"
        c_red "    'Flow didn't parse'    -> sudo journalctl -u nodered -n 100"
        c_red "    'Dashboard not served' -> usually downstream of the above two"
    else
        c_green "  $pass pass · $skip skipped (optional)"
        c_green "  All critical checks passed. Open http://$(hostname -I | awk '{print $1}'):1880/shack"
    fi

    mark_stage "14_verify"
    ok "Stage 14 complete"
}

# ─── Hardware inventory ───────────────────────────────────────────────────────
# Asked ONCE, up front, persisted to $HW_FILE. Every stage that needs to know
# "does this station have X?" reads the persisted answer instead of re-asking —
# the 3 gateway installs (spe-remote / lp700-server / rotator-remote) and Stage
# 13's dashboard-card patching all key off the same HW_* globals. Loaded
# silently on later invocations (and on --stage single runs) so nothing
# re-prompts. Re-answer with `--reset` (wipes state + inventory).

hw_inventory() {
    if [[ -f "$HW_FILE" ]]; then
        # shellcheck disable=SC1090
        source "$HW_FILE"
        return 0
    fi

    banner "Hardware inventory (asked once — drives cards + gateway installs)"
    c_yellow "  Which subsystems does THIS station have? Your answers decide:"
    c_yellow "   • which /shack + /ui dashboard cards show (and which flow tabs run)"
    c_yellow "   • which WebSocket gateways get installed —"
    c_yellow "       SPE → spe-remote · LP-700 → lp700-server · Rotator → rotator-remote"
    c_yellow "  All default to Yes; press Enter to keep one."
    echo
    ask_card HW_FLEX      "FlexRadio (SmartSDR TCP)?                   "
    ask_card HW_SPE       "SPE Expert amplifier?                       "
    ask_card HW_LP700     "LP-700 / LP-500 meter?                      "
    ask_card HW_ROTATOR   "Rotator (Rotor-EZ)?                         "
    ask_card HW_LIGHTNING "Lightning protection (AS3935 / Open-Meteo)? "
    ask_card HW_POWER     "Tasmota power strips?                       "
    ask_card HW_SOLAR     "Solar / space-weather panel?                "
    ask_card HW_DXCC      "DXCC tracker (Club Log + clusters)?         "
    ask_card HW_RBN       "RBN skimmer monitor?                        "
    ask_card HW_RPI       "RPi fleet monitor?                          "
    ask_card HW_NETWORK   "Internet / network monitor?                 "
    ask_card HW_GPSNTP    "GPS NTP server card (gpsntp host)?          "

    # R1 (hard): Tasmota power strips are the switching layer for the antenna
    # disconnect, rotator auto-off, and Flex power relay. If any of those stay,
    # Power must stay too — hiding it would orphan the controls they drive.
    if [[ "$HW_POWER" == '0' ]] \
       && { [[ "$HW_LIGHTNING" == '1' ]] || [[ "$HW_ROTATOR" == '1' ]] || [[ "$HW_FLEX" == '1' ]]; }; then
        echo
        c_yellow "  ⚠ Keeping Power Control — it's the switching layer for:"
        [[ "$HW_LIGHTNING" == '1' ]] && c_yellow "      • Lightning antenna disconnect (Tasmota antenna outlet)"
        [[ "$HW_ROTATOR"   == '1' ]] && c_yellow "      • Rotator auto-off timer (Tasmota rotator outlet)"
        [[ "$HW_FLEX"      == '1' ]] && c_yellow "      • FlexRadio power relay (4-relay board)"
        c_yellow "    Forcing Power = on."
        HW_POWER='1'
    fi
    # R2 (warn): Lightning's TX-inhibit step targets the Flex. Without it the
    # inhibit is a harmless no-op (the request just fails) — warn, don't block.
    if [[ "$HW_FLEX" == '0' ]] && [[ "$HW_LIGHTNING" == '1' ]]; then
        echo
        c_yellow "  ⚠ FlexRadio off but Lightning on: the disconnect chain's TX-inhibit"
        c_yellow "    step targets a radio you don't have (harmless no-op)."
    fi

    echo
    local on="" off="" pair
    for pair in "FlexRadio:$HW_FLEX" "SPE:$HW_SPE" "LP-700:$HW_LP700" \
                "Rotator:$HW_ROTATOR" "Lightning:$HW_LIGHTNING" "Power:$HW_POWER" \
                "Solar:$HW_SOLAR" "DXCC:$HW_DXCC" "RBN:$HW_RBN" \
                "RPi:$HW_RPI" "Network:$HW_NETWORK" "GPS-NTP:$HW_GPSNTP"; do
        if [[ "${pair#*:}" == '1' ]]; then on+="${pair%:*} "; else off+="${pair%:*} "; fi
    done
    c_yellow "  Have:        ${on:-(none)}"
    c_yellow "  Don't have:  ${off:-(none)}"

    cat > "$HW_FILE" <<EOF
# rebuild_pi.sh hardware inventory (answered once; re-run with --reset to change)
HW_FLEX=$HW_FLEX
HW_SPE=$HW_SPE
HW_LP700=$HW_LP700
HW_ROTATOR=$HW_ROTATOR
HW_LIGHTNING=$HW_LIGHTNING
HW_POWER=$HW_POWER
HW_SOLAR=$HW_SOLAR
HW_DXCC=$HW_DXCC
HW_RBN=$HW_RBN
HW_RPI=$HW_RPI
HW_NETWORK=$HW_NETWORK
HW_GPSNTP=$HW_GPSNTP
EOF
    ok "Hardware inventory saved → $HW_FILE"
}

# ─── Main ─────────────────────────────────────────────────────────────────────

usage() {
    sed -n '4,18p' "$0"
    exit 0
}

main() {
    local single_stage="" do_reset=0 do_status=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --reset)  do_reset=1; shift ;;
            --status) do_status=1; shift ;;
            --stage)  single_stage="$2"; shift 2 ;;
            --help|-h) usage ;;
            *) c_red "Unknown arg: $1"; usage ;;
        esac
    done

    if (( do_status )); then
        if [[ -f "$STATE_FILE" ]]; then
            c_bold "Completed stages:"
            cat "$STATE_FILE"
        else
            echo "No state file — nothing run yet."
        fi
        exit 0
    fi

    if (( do_reset )); then
        rm -f "$STATE_FILE" "$HW_FILE"
        ok "State file + hardware inventory wiped — next run starts fresh"
        exit 0
    fi

    preflight

    # Collect (or load) the hardware inventory before any stage runs, so the
    # gateway-install stages and Stage 13 all read the same answers and nothing
    # asks twice. Prompts once on a fresh run; silent on resumes / --stage runs.
    hw_inventory

    if [[ -n "$single_stage" ]]; then
        local target="${STAGES[$((single_stage - 1))]:-}"
        [[ -n "$target" ]] || fail "No stage $single_stage"
        unmark_stage "$target"  # force rerun
        "stage_$target"
        exit 0
    fi

    for stage in "${STAGES[@]}"; do
        if stage_done "$stage"; then
            c_green "  ⏭  Stage $stage already done — skipping"
            continue
        fi
        "stage_$stage"
    done

    echo
    c_bold "════════════════════════════════════════════════════════════"
    c_green "  All stages complete. See REBUILD_PI.md §Step 12 for"
    c_green "  manual verification of Tasmota broker IP + dashboard"
    c_green "  parity. 73 de VU2CPL."
    c_bold "════════════════════════════════════════════════════════════"
}

main "$@"
