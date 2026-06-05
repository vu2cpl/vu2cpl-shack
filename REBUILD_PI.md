# Rebuild the main Node-RED Pi from scratch

Disaster-recovery runbook for the VU2CPL shack automation Pi
(`noderedpi4` @ `192.168.1.169`). Use this when the SD card has died,
the Pi has been replaced with new hardware, or you're cloning the
setup to a different Pi for testing.

For per-host **fleet** onboarding (telemetry + reboot agent on a
different Pi like `gpsntp` or `openwebrxplus`), see
[`DEPLOY_PI.md`](DEPLOY_PI.md) instead. This runbook is for the
shack-control Pi itself.

> **Cloning to a *different* shack?** If you're another operator who
> wants to run this stack at your own QTH (different callsign / grid /
> hardware / MQTT broker), read [`FORK_GUIDE.md`](FORK_GUIDE.md)
> first — it covers the per-site customisation pass you need to do
> before (or after) following this rebuild runbook. The rebuild
> runbook brings up an identical clone of VU2CPL's Pi; FORK_GUIDE
> tells you which knobs to turn for your own station.

**Estimated time:** ~90 minutes from blank SD card to fully working
shack, assuming reasonable internet and existing GitHub SSH keys.

---

## If you're following this for YOUR station (not VU2CPL's)

This runbook stays concrete — it uses VU2CPL's literal values
throughout (Pi IP, hostname, user, timezone) because abstract
placeholders are harder to read than real strings. **Substitute as
you read** wherever you see:

| VU2CPL value | Your value |
|---|---|
| `192.168.1.169` | your Pi's IP (set as a DHCP reservation on your router) |
| `noderedpi4` | your Pi's hostname (anything works; affects MQTT topic prefixes like `rpi/noderedpi4/cpu`) |
| User `vu2cpl` | your Pi user (most paths use `/home/vu2cpl/…`) |
| `Timezone +05:30` (IST) | your local timezone offset |
| `git@github.com:vu2cpl/vu2cpl-shack.git` | your fork URL — or keep VU2CPL's to track upstream without forking |

For the deeper "what to edit AFTER the rebuild" guide (callsign, grid,
Tasmota topics, dashboard rebadging, Club Log credentials), see
[`FORK_GUIDE.md`](FORK_GUIDE.md). That runs once REBUILD_PI is done.

---

## Faster path — the rebuild script

After Step 1 (OS install) and SSH access, you can run
[`rebuild_pi.sh`](rebuild_pi.sh) which automates Stages 2–14 of this
runbook. Stage-based, idempotent, resumable, fail-fast.

```bash
# On the new Pi, after first boot + SSH:
mkdir -p ~/.node-red/projects
git clone https://github.com/vu2cpl/vu2cpl-shack.git \
  ~/.node-red/projects/vu2cpl-shack
bash ~/.node-red/projects/vu2cpl-shack/rebuild_pi.sh
```

> **Why this exact path?** Node-RED's Projects feature serves
> `/shack` from `~/.node-red/projects/<repo>/`, and the script's
> `$REPO_DIR` is set there too. Cloning to `/tmp/` or your home
> dir means the script's stage 7 will clone a **second** copy
> into `~/.node-red/projects/`, and any edits you made to the
> original clone's `rebuild_pi.sh` CONFIG block (for your
> callsign, hostname, fork URL) will be lost. Single path from
> the start.

> **Forking?** The script auto-detects your Pi's username and
> hostname — no pre-config edits required. Your callsign / grid /
> MQTT broker come in via Stage 13's interactive prompts. The only
> reason to edit `rebuild_pi.sh` is if you have your own GitHub
> fork — change `REPO_URL` near the top of the script to your
> fork's URL. See FORK_GUIDE.md Part A3 for details.

The script pauses for these interactive steps (most are opt-in prompts):
- Stage 6 — paste the new SSH public key into your GitHub account
- Stage 11 — opt-in: "Do you have an LP-700 / LP-500 meter?" → installs `lp700-server`
- Stage 12 — paste Club Log API key, password, Telegram token (no echo)
- Stage 13 — opt-in prompt: "(Re-)customize station identity for this
  Pi? [y/N]". Default N keeps current values (upstream defaults or
  whatever you set previously). Press y to (re-)enter callsign /
  grid / MQTT broker / Tasmota antenna topic + channel / threshold /
  reconnect / QTH text, then a "which subsystems do you have?" Y/n
  round for all 12 dashboard cards. Patches Init Defaults, **both
  `mqtt-broker` config nodes** (so every mqtt node dials your broker,
  not the upstream Pi), the Vue TopBar + `CARDS` flags, and disables
  the flow tab for any of SPE/LP-700/Solar/DXCC/RBN you skip.
  Dependency-locked (won't let you drop Power while Lightning/Rotator/
  Flex stay). Always asks; never auto-decides.
- Stage 13b — opt-in: "Do you have a Rotor-EZ rotator?" → clones + installs
  `rotator-remote.service` (`:8090`), prompts for the rotor's serial device,
  runs `setup.sh` + `install-service.sh`, checks `/healthz`. Runs after the
  ws-client Rotator flow is in place (so the serial port is free for the gateway).

Everything else runs automatically. Re-run safely after Ctrl-C or reboot:
state is tracked in `$HOME/.rebuild_pi.state` (survives reboots).
Single-stage re-run with `bash rebuild_pi.sh --stage 9`. Wipe state and
start over with `--reset`.

The runbook below stays as the **manual fallback** when the script
breaks, and as the source-of-truth for what each stage does. Both must
stay in sync — the script's banners reference these section numbers.

---

## What you need

### Hardware

- Raspberry Pi 4B (or newer) with PSU
- Fresh microSD (32 GB minimum)
- AS3935 lightning sensor breakout (I²C + IRQ on **GPIO4**)
- USB serial: SPE Expert 1.5 KFA, Rotor-EZ
- USB HID: Telepost LP-700 (or LP-500)
- Network cable (DHCP reservation @ `192.168.1.169`)

### Software / accounts ready

- Raspberry Pi Imager (or `dd` / `etcher` equivalent)
- A device that can SSH (Mac, laptop)
- GitHub account with read access to `vu2cpl/vu2cpl-shack`
- Club Log credentials (for the DXCC `⚙️ Credentials` node — the
  values are NOT in the repo)
- Telegram bot token + chat_id (same)

---

## Step 1 — Burn the OS, first boot, SSH

1. Use Raspberry Pi Imager → **Raspberry Pi OS Lite (64-bit)**.
   Recommended: **Bookworm** or later.
2. In Imager's **OS customisation** dialog (gear icon):
   - Hostname: `noderedpi4`
   - Username: `vu2cpl`, set a password
   - Wi-Fi: skip (we use ethernet for stability)
   - SSH: enable, **public-key authentication only** (paste your Mac's
     `~/.ssh/id_ed25519.pub`)
   - Locale: India / Asia/Kolkata
3. Burn → eject → insert → power on.
4. Reserve `192.168.1.169` for the new Pi's MAC in your router's DHCP
   table. (CLAUDE.md and every flow node hardcodes that address.)
5. From the Mac:
   ```bash
   ssh vu2cpl@192.168.1.169
   sudo apt update && sudo apt upgrade -y
   sudo reboot
   ```

---

## Step 2 — System packages

After the reboot, SSH back in:

```bash
sudo apt update
sudo apt -y dist-upgrade

# IMPORTANT: if dist-upgrade installed a new kernel, REBOOT NOW
# before running anything else. Check:
ls /var/run/reboot-required 2>/dev/null && echo "← reboot pending; sudo reboot"
# If pending: sudo reboot, then SSH back in.
# (Without this, any later `modprobe` returns "FATAL: Module … not
# found" — running kernel's /lib/modules/ dir is stale until reboot.)

sudo apt install -y \
  git \
  mosquitto mosquitto-clients \
  python3 python3-pip python3-venv \
  python3-paho-mqtt python3-rpi.gpio python3-smbus \
  python3-serial \
  i2c-tools \
  build-essential \
  curl jq

# Enable I²C for the AS3935 sensor
sudo raspi-config nonint do_i2c 0
sudo raspi-config nonint do_serial_hw 0   # enable hardware UART (rotator / SPE)

# Verify I²C bus
sudo modprobe i2c-dev                      # raspi-config sets dtparam; module may still need loading
ls /dev/i2c-1                              # should exist; if missing, reboot and retry
sudo i2cdetect -y 1                        # AS3935 should appear at 0x03 (or 0x01/0x02)
```

> **If `modprobe` returns `FATAL: Module i2c-dev not found`**: the
> dist-upgrade above installed a new kernel and you haven't rebooted
> yet. `/lib/modules/$(uname -r)/` no longer matches the running
> kernel. Fix: `sudo reboot`, then re-run from `sudo modprobe i2c-dev`.

> **If `/dev/i2c-1` still doesn't appear** after `modprobe + reboot`:
> only the **legacy Pi-side `as3935.service` daemon** needs it, and
> that daemon has been **standby fallback** since 2026-05-11 (the
> ESP32 bridge in `vu2cpl-as3935-bridge` is the live publisher).
> Skip this step and continue — normal shack operation is unaffected.
> `rebuild_pi.sh` Stage 1 now warns-not-fails on the same condition,
> and aborts cleanly with a reboot-recovery message when it detects
> the post-dist-upgrade kernel-pending state.

---

## Step 3 — Mosquitto broker

```bash
sudo tee /etc/mosquitto/conf.d/lan.conf <<'EOF'
# VU2CPL shack broker — LAN-only, no auth
listener 1883
allow_anonymous true
persistence true
persistence_location /var/lib/mosquitto/
log_dest file /var/log/mosquitto/mosquitto.log
EOF

sudo systemctl enable --now mosquitto
sudo systemctl status mosquitto --no-pager   # should be active (running)

# Smoke test from another terminal:
mosquitto_sub -h localhost -t '$SYS/#' -C 5
```

---

## Step 4 — Node-RED

```bash
# Official install script (handles Node.js LTS + Node-RED in one go)
bash <(curl -sL https://raw.githubusercontent.com/node-red/linux-installers/master/deb/update-nodejs-and-nodered)
# Answer: yes to install, yes to systemd, no to settings.js prompts (we'll edit manually)

# Enable + start
sudo systemctl enable --now nodered
sudo systemctl status nodered --no-pager

# Wait until "Started Node-RED" appears in journalctl
journalctl -u nodered -f                     # Ctrl-C when ready
```

Open `http://192.168.1.169:1880` in a browser to confirm the editor loads.

### Install required palette packages

```bash
cd ~/.node-red
npm install \
  node-red-dashboard \
  node-red-contrib-uibuilder \
  node-red-node-serialport \
  node-red-contrib-flexradio \
  node-red-contrib-ui-svg \
  node-red-node-ping \
  node-red-configurable-ping \
  node-red-node-rbe \
  node-red-contrib-loop \
  node-red-contrib-ui-level
```

`node-red-dashboard` is Dashboard 1 (the legacy `/ui`).
`node-red-contrib-uibuilder` serves the Vue 3 `/shack` SPA — both URLs
coexist on the same Node-RED instance with no conflict.

> Dashboard 2 (`@flowfuse/node-red-dashboard`) was evaluated as a POC
> in 2026-05-24 and **retired 2026-05-26** in favour of uibuilder + Vue
> (see SHACK_CHANGELOG). Don't install it — the flow has no D2 nodes
> any more and the dashboard would just be empty.

### Enable the Projects feature

Edit `~/.node-red/settings.js` and find the `editorTheme` section. Add:

```javascript
projects: {
    enabled: true,
    workflow: {
        mode: "manual"
    }
}
```

### Enable dashboard auth (2026-05-27 — TODO #32)

In the same `settings.js`, uncomment and populate two blocks so the
dashboards (`/ui`, `/shack`) and all HTTP control endpoints
(`/lightning/*`, `/dxcc/*`, `/rotator/*`) require login. Reuse the
existing `adminAuth.users[0].password` bcrypt hash — single credential
across editor + dashboards keeps Safari's password manager happy.

```javascript
httpNodeAuth: { user: "vu2cpl", pass: "<your bcrypt hash from adminAuth>" },

ui: {
    path: "ui",
    auth: {
        type: "credentials",
        users: [
            {
                username: "vu2cpl",
                password: "<same bcrypt hash>",
                permissions: "*"
            }
        ]
    }
},
```

Generate a fresh bcrypt hash if you don't have one:

```bash
node-red admin hash-pw
# Enter the password; copy the resulting $2y$08$... hash
# Use the same hash in all THREE places (adminAuth, httpNodeAuth, ui.auth)
```

Verify after restart:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:1880/ui
# Expect 401 (unauthorized — auth working)
curl -s -o /dev/null -w '%{http_code}\n' -u vu2cpl:WRONGPASS http://localhost:1880/ui
# Expect 401 (wrong password rejected)
# Browser test: open /ui → Safari prompts for credentials
```

Then restart Node-RED:

```bash
sudo systemctl restart nodered
```

---

## Step 5 — GitHub SSH key + clone the project

```bash
ssh-keygen -t ed25519 -C "vu2cpl@noderedpi4" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Copy the public key. On GitHub:
**Settings → SSH and GPG keys → New SSH key** → paste → save.

Clone the repo as a Node-RED Project. The cleanest way:

1. Open `http://192.168.1.169:1880` in a browser.
2. Hamburger menu → **Projects → New Project → Clone Repository**.
3. Project name: `vu2cpl-shack`. Git URL:
   `git@github.com:vu2cpl/vu2cpl-shack.git`. Auth: SSH key from above.
4. Node-RED clones into `~/.node-red/projects/vu2cpl-shack/` and
   activates the project.

Or do it manually from the shell:

```bash
mkdir -p ~/.node-red/projects
cd ~/.node-red/projects
git clone git@github.com:vu2cpl/vu2cpl-shack.git
# Then in Node-RED editor → Projects → Open Project → vu2cpl-shack
```

### Set up the `nrsave` shell function

`nrsave` regenerates the DXCC tab extract (CLAUDE.md rule #4) and
commits flows.json + the extract in one shot. As of 2026-05-11 it
is a bash function (not an alias), because aliases can't run logic
between args.

```bash
cat >> ~/.bashrc <<'EOF'

# nrsave — regen DXCC tab extract + stage flows.json + commit (CLAUDE.md rule #4)
nrsave() {
    cd ~/.node-red/projects/vu2cpl-shack || return 1
    python3 -c 'import json; d=json.load(open("flows.json")); v=[n for n in d if n.get("z")=="d110d176c0aad308" or n.get("id")=="d110d176c0aad308"]; json.dump(v,open("clublog_dxcc_tracker_v7.json","w"),indent=2)' || return 1
    git add flows.json clublog_dxcc_tracker_v7.json
    git commit -m "$1"
}
EOF
source ~/.bashrc
type nrsave   # should report: nrsave is a function
```

---

## Step 6 — Enable the file context store (one-time)

This makes `flow.set(..., 'file')` persistent across reboots —
required for DXCC seed persistence and a few other places.

```bash
~/.node-red/projects/vu2cpl-shack/enable_file_context.sh
sudo systemctl restart nodered
```

---

## Step 7 — Deploy Pi-side scripts and systemd units

The repo carries every operational script that runs outside Node-RED.
Copy them to `/home/vu2cpl/`, fix ownership, install systemd units,
add the sudoers entry, and the per-minute crontab.

```bash
cd ~/.node-red/projects/vu2cpl-shack

# User-space scripts (running as vu2cpl, not root)
sudo cp as3935_mqtt.py    /home/vu2cpl/as3935_mqtt.py
sudo cp as3935_tune.py    /home/vu2cpl/as3935_tune.py
sudo cp rpi_agent.py      /home/vu2cpl/rpi_agent.py
sudo cp monitor.sh        /home/vu2cpl/monitor.sh
sudo cp power_spe_on.py   /home/vu2cpl/power_spe_on.py
# The 2026-05-07 quirk: sudo cp leaves files root-owned; reset:
sudo chown vu2cpl:vu2cpl  /home/vu2cpl/as3935_mqtt.py \
                          /home/vu2cpl/as3935_tune.py \
                          /home/vu2cpl/rpi_agent.py \
                          /home/vu2cpl/monitor.sh \
                          /home/vu2cpl/power_spe_on.py
sudo chmod +x /home/vu2cpl/monitor.sh /home/vu2cpl/as3935_tune.py

# Systemd units
sudo cp as3935.service    /etc/systemd/system/as3935.service
sudo cp rpi-agent.service /etc/systemd/system/rpi-agent.service
sudo systemctl daemon-reload

# Sudoers — allow the rpi-agent service to call reboot/shutdown
echo 'vu2cpl ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown' | \
  sudo tee /etc/sudoers.d/rpi-agent
sudo chmod 440 /etc/sudoers.d/rpi-agent
sudo visudo -c                            # must print "parsed OK"

# Telemetry cron (every minute)
(crontab -l 2>/dev/null | grep -v 'monitor.sh' ; \
 echo '* * * * *  /home/vu2cpl/monitor.sh') | crontab -
crontab -l | grep monitor.sh              # one line expected

# Enable + start rpi-agent. NOTE: as3935 is intentionally NOT enabled.
# The ESP32 bridge (vu2cpl-as3935-bridge repo) is the primary publisher
# to lightning/as3935/*. The Pi daemon's files stay installed as a
# fallback — if the ESP32 fails, `sudo systemctl enable --now as3935`
# resurrects the Pi as publisher. Enabling both at once would race the
# MQTT topic and corrupt retained status.
sudo systemctl enable --now rpi-agent
sudo systemctl status rpi-agent --no-pager
```

### Smoke-test telemetry

```bash
mosquitto_sub -h localhost -t 'rpi/noderedpi4/#' -v -C 7
# Expect: cpu / mem / temp / disk / uptime / ip / status

mosquitto_sub -h localhost -t 'lightning/as3935/#' -v -C 3
# Expect at minimum: lightning/as3935/status (retained "ready"),
#         lightning/as3935/hb (heartbeat every 30s)
```

---

## Step 8 — Hardware setup

### USB serial — udev rules

The flows reference USB devices by their stable `/dev/serial/by-id/`
paths, so udev rules aren't strictly required. Verify the paths exist:

```bash
ls -la /dev/serial/by-id/
# Expect (substrings):
#   usb-FTDI_FT232R_USB_UART_AI040UZR-if00-port0  (SPE primary)
#   usb-FTDI_FT232R_USB_UART_AI040V80-if00-port0  (SPE alternate)
#   usb-FTDI_FT232R_USB_UART_AL05J29R-if00-port0  (Rotor-EZ)
```

### LP-700 / LP-500 USB HID — udev for the WS gateway

```bash
sudo tee /etc/udev/rules.d/10-telepost.rules <<'EOF'
# Telepost LP-500 / LP-700 — readable by lp700-server (legacy rule)
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="04d8", ATTRS{idProduct}=="0001", \
    GROUP="telepost", MODE="0660"
EOF
sudo groupadd -f telepost
sudo usermod -aG telepost vu2cpl
sudo udevadm control --reload-rules
sudo udevadm trigger
```

(The lp700-server's own `redeploy.sh` will install a second udev rule
at `/etc/udev/rules.d/99-lp700.rules` automatically — see Step 9.)

### AS3935 wiring confirmation

The chip's INT line must reach **GPIO4** (Pi physical pin 7), not
GPIO17 (the often-cited but wrong default). I²C SDA/SCL on
GPIO2/GPIO3 (pins 3 and 5). 3V3 power on pin 1, GND on pin 6.

Verify after powering on:

```bash
sudo i2cdetect -y 1                       # should show device at 0x03 (default)
sudo systemctl restart as3935
journalctl -u as3935 -n 30 --no-pager     # should show "ready" + heartbeat
```

If counters stay stuck at zero, the IRQ pin is wrong — re-check
the wiring against pin 7 / GPIO4.

---

## Step 9 — `lp700-server` (LP-700 power meter gateway)

The LP-700 is owned by a separate Go service so multiple clients
(Node-RED, the embedded web UI, future apps) can subscribe in
parallel.

```bash
cd ~
git clone https://github.com/VU3ESV/LP-700-Server.git
cd LP-700-Server
./redeploy.sh                             # builds + installs to /usr/local/bin
                                          # + installs lp700-server.service
                                          # + installs 99-lp700.rules

sudo systemctl status lp700-server --no-pager
curl http://localhost:8089/healthz        # expect: ok
```

---

## Step 10 — DXCC + Telegram secrets via systemd

Since 2026-05-10 the API key, password, and Telegram token live in a
systemd drop-in, NOT in the Credentials node body. Node-RED reads
them at startup via `env.get('VAR_NAME')`.

```bash
sudo mkdir -p /etc/systemd/system/nodered.service.d/
sudo tee /etc/systemd/system/nodered.service.d/secrets.conf <<'EOF'
[Service]
Environment="CLUBLOG_API_KEY=<your-club-log-api-key>"
Environment="CLUBLOG_PASSWORD=<your-club-log-password>"
Environment="TELEGRAM_TOKEN=<your-telegram-bot-token>"
Environment="TELEGRAM_CHAT_ID=<your-telegram-chat-id>"
EOF
sudo chmod 600 /etc/systemd/system/nodered.service.d/secrets.conf
sudo chown root:root /etc/systemd/system/nodered.service.d/secrets.conf
sudo systemctl daemon-reload
sudo systemctl restart nodered
```

These three values are NOT in the repo — they live only on the Pi.
Source them from your password manager / Club Log account / Telegram
@BotFather.

The Credentials node (`08dcd5378a79bb18`) on the DXCC tab loads them
at deploy/restart time. Verify with the node's status badge:

- **Green** `Config loaded: VU2CPL-1 / tg:<chat-id>` → all three env-vars
  reached the Node-RED process
- **Red** `Missing: CLUBLOG_API_KEY,...` → env-var didn't reach the
  process; check `secrets.conf` has the right `Environment=` syntax
  (quoted values, no spaces around `=`) and that you ran
  `daemon-reload` + `restart nodered`

The remaining non-secret config (`cl_email`, `cl_callsign`,
`cl_login_ssid`, `tg_chat_id`, `cfg_flows_dir`) stays inline in the
Credentials node body and is committed to the repo — you don't need to
edit them on a fresh rebuild as long as the values match VU2CPL's
operator identity.

**Rotation flow** (after rebuild, when secrets need refresh):
edit `secrets.conf` → `sudo systemctl restart nodered`. No editor
deploy, no commit, no flows.json change.

---

## Step 11 — Tasmota devices

Each Tasmota device must publish to the same broker IP. If the new
Pi kept the `192.168.1.169` reservation, **nothing to do here** —
the devices are already pointed at that address.

If you had to use a different IP, update each Tasmota device:

1. Browse to each device's web UI (`http://powerstrip1.local`, etc.)
2. **Configuration → Configure MQTT → Host** = new Pi IP → Save.

The 5 devices to check:
`powerstrip1`, `powerstrip2`, `powerstrip3`, `4relayboard`,
`16Amasterswitch`.

**Timezone:** all 5 devices run `Timezone +05:30` (IST). If you ever
reflash a Tasmota device, the default reverts to UTC, which makes
`ENERGY.Today` on `16Amasterswitch` roll over at 05:30 IST (00:00
UTC) instead of local midnight. Restore with:

```bash
for t in powerstrip1 powerstrip2 powerstrip3 4relayboard 16Amasterswitch; do
  mosquitto_pub -h 192.168.1.169 -t "cmnd/$t/Timezone" -m "5:30"
done
```

Verify (empty payload = read):

```bash
mosquitto_sub -h 192.168.1.169 -t 'stat/+/RESULT' -v -W 8 &
sleep 0.3
for t in powerstrip1 powerstrip2 powerstrip3 4relayboard 16Amasterswitch; do
  mosquitto_pub -h 192.168.1.169 -t "cmnd/$t/Timezone" -n
done
wait
```

Each reply should be `{"Timezone":"+05:30"}`.

---

## Step 12 — Final verification

A 16-point checklist for the operator's full-stack verification.

*Note: the verification stage is `verify` — now positionally `--stage 15` since the optional `13b` rotator stage was inserted before it (`bash rebuild_pi.sh --stage 15`). It uses a smaller split (7 critical + 5 optional) tuned to the script's perspective — every Pi has Node-RED/Mosquitto/rpi-agent, but LP-700/rotator/AS3935/GPS-NTP are operator-specific. The manual checklist below adds the wider lens that's useful when verifying by hand.*

| # | Check | Pass criterion |
|---|-------|----------------|
| 1 | Pi reachable at `192.168.1.169` | `ping -c 3 192.168.1.169` from Mac |
| 2 | Node-RED editor loads | Browser → `http://192.168.1.169:1880` |
| 3 | Dashboard 1 (legacy) loads | Browser → `http://192.168.1.169:1880/ui` |
| 4 | **Vue `/shack` dashboard loads** | Browser → `http://192.168.1.169:1880/shack`. Should show top bar + 12 cards (all collapsed by default). LIVE pill should be green next to the callsign within ~2 s of page load. iPad/iPhone: Safari Share → Add to Home Screen installs as "Shack" |
| 5 | All 11 flow tabs deploy clean | No red triangles on tab labels |
| 6 | MQTT broker alive | `mosquitto_sub -h localhost -t '#' -C 5` shows traffic |
| 7 | AS3935 publishing (from ESP32 bridge) | Topic `lightning/as3935/hb` ticks every 30 s. The Pi daemon (`as3935.service`) is intentionally disabled — the ESP-WROOM-32 in [`vu2cpl-as3935-bridge`](https://github.com/vu2cpl/vu2cpl-as3935-bridge) is the live publisher. If the ESP32 is offline / dead, `sudo systemctl enable --now as3935` on this Pi resurrects the indoor daemon as fallback |
| 8 | RPi telemetry publishing | Topic `rpi/noderedpi4/cpu` updates every 60 s |
| 9 | LP-700 telemetry alive | Dashboard LP-700 panel shows live values |
| 10 | FlexRadio TCP up | Dashboard FlexRadio panel shows slice state |
| 11 | Tasmota state sync | Toggle a power outlet from dashboard → relay clicks → state syncs back |
| 12 | DXCC alerts firing | DXCC tab status badges green; spots arriving in the table. `Login + Parse + Dedup` shows recent activity (`[cluster1] DX de ...`); `DXCC Prefix Lookup + Alert Classify` shows per-spot status (`worked` / `NEW DXCC` / etc.) |
| 13 | Lightning auto-disconnect | Click `TEST ⚡ 6 km DISCONNECT` inject → antenna + radio go OFF |
| 14 | Lightning event log file | File `~/.node-red/projects/vu2cpl-shack/nr_lightning_events.jsonl` exists and contains recent events: `tail -f ~/.node-red/projects/vu2cpl-shack/nr_lightning_events.jsonl` should show JSON event records. The path is hardcoded in the **Init Defaults** node on the Lightning tab. This JSONL file persists across Node-RED restarts |
| 15 | Chrony / GPS card live | Dashboard tab `Shack Monitoring tools` → `Network Monitor` group shows `Chrony status card` updating every minute. Requires `gpsntp.local` to be up + its publisher cron firing (`/usr/local/bin/gpsntp-mqtt-publish.sh`). If silent: `mosquitto_sub -h localhost -t shack/gpsntp/chrony -v` should print one retained payload immediately + a fresh one each minute |
| 16 | DXCC cty.xml cache exists | File `~/.node-red/projects/vu2cpl-shack/nr_cty_maps.json` exists and is reasonably-sized (~170 KB). It's written by `Parse cty.xml → Prefix Maps` after the first successful Club Log fetch (~5-10 s post-deploy). Verifies the resilience path — if you restart Node-RED later while Club Log is unreachable, the bootstrap reads this cache at `onceDelay:1` so DXCC prefix resolution keeps working. Check: `ls -la ~/.node-red/projects/vu2cpl-shack/nr_cty_maps.json` (size > 100 KB, mtime within last few minutes if you just restarted). Spot-check content: `python3 -c 'import json; d=json.load(open("/home/vu2cpl/.node-red/projects/vu2cpl-shack/nr_cty_maps.json")); print(d["stats"])'` should print `{"entities": ~340, "prefixes": ~2900, "exceptions_": ~9000}`. |

If 1–8 pass but 9 fails: re-check Step 9 (lp700-server install).
If 4 fails (`/shack` 404 or blank): check `node-red-contrib-uibuilder` is installed (`grep uibuilder ~/.node-red/package.json`); confirm the `Shack Vue` uibuilder node on the `Vue Dashboard` flow tab is deployed; check that `~/.node-red/projects/vu2cpl-shack/uibuilder/shack/src/` contains `index.html`, `index.js`, `index.css`, `vue.global.prod.js`. No Node-RED restart needed for front-end file changes — uibuilder serves them directly from disk.
If 12 fails: re-check Step 10 (credentials node) and the file context store.
If 14 fails (JSONL file missing or empty): The Lightning tab is working but events aren't being persisted. Verify the **Init Defaults** node (`ec1fd4dece8c4dc0`) on the Lightning tab has correctly set `flow.set('cfg_events_jsonl', ...)`. Trigger a test event via `TEST ⚡ 6 km DISCONNECT` inject and watch for the file to be created/updated. If still missing, the file-context store from Step 6 may not be properly enabled — re-run `enable_file_context.sh` and restart Node-RED.
If 15 fails but other cards are fine: not a noderedpi4 problem — it's gpsntp.local. See `pi-gps-ntp-server` repo.

---

## Common failure modes

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `nrsave` reports "nothing to commit" after every Deploy | Projects feature not enabled, flows.json not in the project dir | Re-do Step 4's projects block + Step 5 |
| Two publishers fighting on `lightning/as3935/*` | Pi `as3935.service` was enabled despite ESP32 also running | `sudo systemctl disable --now as3935` — ESP32 (vu2cpl-as3935-bridge) is the canonical publisher; Pi daemon stays installed but disabled |
| AS3935 daemon starts but counters never increment (only if Pi fallback is enabled) | IRQ wired to wrong GPIO | Re-check pin 7 / GPIO4 (Step 8) |
| Mosquitto refuses connections from Tasmota devices | Default config bound to localhost only | Re-do Step 3's `lan.conf` |
| Node-RED can't open USB serial | User not in `dialout` group | `sudo usermod -aG dialout vu2cpl` then re-login |
| LP-700 dashboard frozen at one value | aggregator reading wrong msg shape (the 2026-05-09 fix) | The repo already has the fix; if you see this on a fresh clone, double-check `git pull` actually landed |
| `flow.set('foo', 'file')` not persisting | File context store not enabled | Re-run `enable_file_context.sh` (Step 6) |

---

## Files referenced by this runbook

### Pi-side scripts + systemd units (deployed during Step 7)

| Repo file | Deployment target |
|-----------|-------------------|
| `as3935_mqtt.py` | `/home/vu2cpl/as3935_mqtt.py` |
| `as3935_tune.py` | `/home/vu2cpl/as3935_tune.py` |
| `as3935.service` | `/etc/systemd/system/as3935.service` |
| `rpi_agent.py` | `/home/vu2cpl/rpi_agent.py` |
| `rpi-agent.service` | `/etc/systemd/system/rpi-agent.service` |
| `monitor.sh` | `/home/vu2cpl/monitor.sh` (+ user crontab `* * * * *`) |
| `power_spe_on.py` | `/home/vu2cpl/power_spe_on.py` |
| `enable_file_context.sh` | run once in-place from the repo |
| `flows.json` | loaded by Node-RED when the project is active |

### Runtime data files (auto-generated; live in the flows directory)

These are written by Node-RED at runtime, not deployed by the rebuild
script. All live in `~/.node-red/projects/vu2cpl-shack/`. The first
three are gitignored (per-station data, regenerable). The JSONL one
is the historical event log.

| File | Written by | Purpose |
|---|---|---|
| `nr_dxcc_seed.json` | `Fetch All Modes + Parse` (daily 02:00 cron) | DXCC worked/confirmed table from Club Log. Bootstrap reads it on startup so the DXCC tab works even when Club Log is unreachable. ~700 KB. |
| `nr_dxcc_blacklist.json` | DXCC blacklist add/remove handlers | Callsigns the operator has muted from alerts. Survives restarts. |
| `nr_cty_maps.json` | `Parse cty.xml → Prefix Maps` (after every successful Club Log fetch) | Parsed prefix → DXCC entity map. Bootstrap reads it at `onceDelay:1` so prefix resolution works **even if Club Log is unreachable at restart** — eliminates a silent-failure mode. ~170 KB. (Added 2026-05-28.) |
| `nr_lightning_events.jsonl` | `Append Lightning JSONL` | Historical strike/disconnect/reconnect/bypass/sensor event log. One JSON object per line. Never rotated by Node-RED. |

All four are safe to delete — they regenerate from upstream sources
(Club Log, the next OM poll, the next cluster spot). Backups are nice
to have but not required; the JSONL is the only one with truly
unrecoverable history.

---

## See also

- [`README.md`](README.md) — repo overview, subsystem summaries
- [`CLAUDE.md`](CLAUDE.md) — operator deep-reference
- [`DEPLOY_PI.md`](DEPLOY_PI.md) — adding a *fleet* host (telemetry +
  reboot agent only — different goal from this runbook)
- [`DXCC.md`](DXCC.md) — DXCC subsystem reference
- [`SHACK_CHANGELOG.md`](SHACK_CHANGELOG.md) — dated history of every
  non-DXCC change

---

*73 de VU2CPL*
