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
#  State file: /tmp/rebuild_pi.state — persists across re-runs (not reboots).
#  Idempotent: every stage is safe to re-run.
#
#  Pre-requisites (out of script scope):
#    - Pi OS Lite 64-bit installed (Step 1 of REBUILD_PI.md)
#    - Hostname `noderedpi4`, user `vu2cpl`, SSH access
#    - Pi has DHCP reservation @ 192.168.1.169
#    - Internet reachable
#
#  See REBUILD_PI.md for the manual fallback procedure.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

readonly STATE_FILE=/tmp/rebuild_pi.state
readonly REPO_URL='git@github.com:vu2cpl/vu2cpl-shack.git'
readonly REPO_DIR="$HOME/.node-red/projects/vu2cpl-shack"
readonly LP700_DIR="$HOME/LP-700-Server"

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
    "13_verify"
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

stage_done()    { grep -qx "$1" "$STATE_FILE" 2>/dev/null; }
mark_stage()    { mkdir -p "$(dirname "$STATE_FILE")"; echo "$1" >> "$STATE_FILE"; }
unmark_stage()  { sed -i "/^$1$/d" "$STATE_FILE" 2>/dev/null || true; }

# ─── Pre-flight ───────────────────────────────────────────────────────────────

preflight() {
    banner "Pre-flight checks"

    # Must be vu2cpl, not root
    if [[ "$(id -un)" != "vu2cpl" ]]; then
        fail "Run as user 'vu2cpl', not '$(id -un)'. Sudo will be requested when needed."
    fi
    ok "Running as vu2cpl"

    # Hostname
    if [[ "$(hostname)" != "noderedpi4" ]]; then
        warn "Hostname is '$(hostname)', expected 'noderedpi4'."
        warn "Some scripts (monitor.sh, MQTT topics) will publish under the current hostname."
        prompt_continue "Continue anyway?"
    else
        ok "Hostname: noderedpi4"
    fi

    # Internet
    if ! curl -sS --max-time 5 -o /dev/null https://github.com; then
        fail "github.com unreachable — check network."
    fi
    ok "Internet reachable"

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
    sudo raspi-config nonint do_i2c 0
    sudo raspi-config nonint do_serial_hw 0

    step "Verify I²C bus"
    [[ -e /dev/i2c-1 ]] || fail "/dev/i2c-1 not present after raspi-config"
    ok "/dev/i2c-1 present"

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

    step "Verify Node-RED listening on :1880"
    timeout 5 bash -c 'until curl -sf http://localhost:1880 >/dev/null; do sleep 1; done' \
        || fail "Node-RED not responding on :1880 after 5 s"
    ok "Node-RED reachable at http://localhost:1880"

    mark_stage "03_nodered_install"
    ok "Stage 3 complete"
}

# ─── Stage 4: Node-RED palette ───────────────────────────────────────────────

stage_04_nodered_palette() {
    banner "Stage 4 — Node-RED palette (REBUILD_PI.md Step 4)"

    cd "$HOME/.node-red"

    local packages=(
        node-red-dashboard
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

    local settings="$HOME/.node-red/settings.js"
    [[ -f "$settings" ]] || fail "$settings not found — Stage 3 should have created it"

    if grep -q '"manual"' "$settings" && grep -q 'projects:' "$settings"; then
        ok "Projects feature already enabled"
    else
        step "Patch settings.js to enable Projects (mode: manual)"
        sudo cp "$settings" "${settings}.bak.$(date +%Y%m%d-%H%M%S)"

        # Insert projects block before the closing brace of module.exports
        python3 <<PYEOF
import re, sys
path = "$settings"
with open(path) as f: txt = f.read()
if 'projects:' not in txt:
    block = """
    projects: {
        enabled: true,
        workflow: { mode: "manual" }
    },
"""
    # Insert just before the final closing brace of module.exports = {...}
    txt = re.sub(r"(\n\}\s*;?\s*)$", block + r"\1", txt)
    with open(path, 'w') as f: f.write(txt)
PYEOF
        ok "settings.js patched"
    fi

    step "Restart Node-RED to pick up the change"
    sudo systemctl restart nodered
    sleep 5
    timeout 5 bash -c 'until curl -sf http://localhost:1880 >/dev/null; do sleep 1; done' \
        || fail "Node-RED not responding after restart"
    ok "Node-RED back up"

    mark_stage "05_settings_js"
    ok "Stage 5 complete"
}

# ─── Stage 6: GitHub SSH key ─────────────────────────────────────────────────

stage_06_github_ssh() {
    banner "Stage 6 — GitHub SSH key (REBUILD_PI.md Step 5)"

    if [[ ! -f ~/.ssh/id_ed25519 ]]; then
        step "Generate ed25519 keypair"
        ssh-keygen -t ed25519 -C "vu2cpl@$(hostname)" -f ~/.ssh/id_ed25519 -N ""
    else
        ok "Keypair already exists"
    fi

    echo
    c_yellow "  ┌─ Add this public key to GitHub: ─────────────────────────────────"
    c_yellow "  │ Settings → SSH and GPG keys → New SSH key → paste:"
    c_yellow "  │"
    sed 's/^/  │ /' ~/.ssh/id_ed25519.pub
    c_yellow "  │"
    c_yellow "  └──────────────────────────────────────────────────────────────────"

    prompt_continue "Once added, hit Enter to verify GitHub access"

    step "Test SSH to GitHub"
    if ssh -T -o StrictHostKeyChecking=accept-new git@github.com 2>&1 | grep -q "successfully authenticated"; then
        ok "GitHub SSH auth OK"
    else
        fail "GitHub auth failed — pubkey not added or wrong account"
    fi

    mark_stage "06_github_ssh"
    ok "Stage 6 complete"
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

    step "Configure git alias 'nrsave' on the repo"
    git -C "$REPO_DIR" config alias.save \
        '!f() { git add flows.json && git commit -m "$1"; }; f'

    if ! grep -q 'nrsave' ~/.bashrc 2>/dev/null; then
        step "Add nrsave shell function to ~/.bashrc"
        cat >> ~/.bashrc <<EOF

# nrsave — git add+commit flows.json from any cwd (added by rebuild_pi.sh)
nrsave () { git -C "$REPO_DIR" save "\$1"; }
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
        sudo cp "$f" "/home/vu2cpl/$f"
        sudo chown vu2cpl:vu2cpl "/home/vu2cpl/$f"
    done
    sudo chmod +x /home/vu2cpl/monitor.sh /home/vu2cpl/as3935_tune.py

    # Systemd units
    step "Install systemd units"
    sudo cp as3935.service    /etc/systemd/system/as3935.service
    sudo cp rpi-agent.service /etc/systemd/system/rpi-agent.service
    sudo systemctl daemon-reload

    # Sudoers
    step "Install sudoers entry"
    echo 'vu2cpl ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown' | \
        sudo tee /etc/sudoers.d/rpi-agent > /dev/null
    sudo chmod 440 /etc/sudoers.d/rpi-agent
    sudo visudo -c >/dev/null || fail "sudoers syntax error"

    # Crontab
    step "Schedule monitor.sh in user crontab"
    (crontab -l 2>/dev/null | grep -v 'monitor.sh' ; \
     echo '* * * * *  /home/vu2cpl/monitor.sh') | crontab -

    # Enable + start services
    step "Enable + start as3935 and rpi-agent services"
    sudo systemctl enable --now as3935 rpi-agent
    sleep 2
    systemctl is-active --quiet rpi-agent || warn "rpi-agent not active — check journalctl -u rpi-agent"
    systemctl is-active --quiet as3935    || warn "as3935 not active — check journalctl -u as3935 (may be normal if AS3935 hardware absent)"

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
    sudo usermod -aG telepost vu2cpl
    sudo udevadm control --reload-rules
    sudo udevadm trigger
    ok "udev rules reloaded"

    step "Confirm USB serial paths if hardware is plugged in"
    if ls /dev/serial/by-id/ 2>/dev/null | grep -qE 'FT232R|FTDI'; then
        ls -la /dev/serial/by-id/ | grep -E 'FT232R|FTDI' | sed 's/^/      /'
    else
        warn "No FTDI USB serial devices visible — connect SPE / Rotor cables and re-run if needed"
    fi

    mark_stage "10_udev_rules"
    ok "Stage 10 complete"
}

# ─── Stage 11: lp700-server ──────────────────────────────────────────────────

stage_11_lp700_server() {
    banner "Stage 11 — lp700-server gateway (REBUILD_PI.md Step 9)"

    if systemctl is-active --quiet lp700-server 2>/dev/null; then
        ok "lp700-server already active"
    else
        if [[ ! -d "$LP700_DIR" ]]; then
            step "Clone VU3ESV/LP-700-Server"
            git clone https://github.com/VU3ESV/LP-700-Server.git "$LP700_DIR"
        fi
        step "Run redeploy.sh"
        cd "$LP700_DIR" && ./redeploy.sh
    fi

    step "Verify /healthz"
    if curl -sf http://localhost:8089/healthz >/dev/null; then
        ok "lp700-server /healthz responds"
    else
        warn "lp700-server /healthz not responding — check journalctl -u lp700-server"
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

# ─── Stage 13: verification (matches REBUILD_PI.md Step 12 + #13) ───────────

stage_13_verify() {
    banner "Stage 13 — Final verification (REBUILD_PI.md Step 12)"

    local pass=0 fail=0

    check() {
        local label="$1" cmd="$2"
        if eval "$cmd" >/dev/null 2>&1; then
            ok "$label"
            ((pass++))
        else
            warn "$label  ← FAILED"
            ((fail++))
        fi
    }

    check "Pi reachable on LAN"     "ping -c 1 -W 1 192.168.1.169"
    check "Node-RED editor :1880"   "curl -sf http://localhost:1880"
    check "Node-RED dashboard /ui"  "curl -sf http://localhost:1880/ui"
    check "Mosquitto broker alive"  "timeout 3 mosquitto_sub -h localhost -t '\$SYS/#' -C 1"
    check "as3935.service active"   "systemctl is-active --quiet as3935"
    check "rpi-agent.service active" "systemctl is-active --quiet rpi-agent"
    check "lp700-server /healthz"   "curl -sf http://localhost:8089/healthz"
    check "rpi/$(hostname) telemetry" "timeout 65 mosquitto_sub -h localhost -t 'rpi/$(hostname)/cpu' -C 1"
    check "lightning/as3935/hb"     "timeout 35 mosquitto_sub -h localhost -t 'lightning/as3935/hb' -C 1"
    check "shack/gpsntp/chrony"     "timeout 65 mosquitto_sub -h localhost -t 'shack/gpsntp/chrony' -C 1"

    echo
    if [[ $fail -gt 0 ]]; then
        c_yellow "  $pass pass, $fail fail. See REBUILD_PI.md §Common failure modes."
    else
        c_green  "  All $pass checks passed. Shack is up."
    fi

    mark_stage "13_verify"
    ok "Stage 13 complete"
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
        rm -f "$STATE_FILE"
        ok "State file wiped — next run starts from Stage 1"
        exit 0
    fi

    preflight

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
