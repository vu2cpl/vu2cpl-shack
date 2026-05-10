# Rebuild the main Node-RED Pi from scratch

Disaster-recovery runbook for the VU2CPL shack automation Pi
(`noderedpi4` @ `192.168.1.169`). Use this when the SD card has died,
the Pi has been replaced with new hardware, or you're cloning the
setup to a different Pi for testing.

For per-host **fleet** onboarding (telemetry + reboot agent on a
different Pi like `gpsntp` or `openwebrxplus`), see
[`DEPLOY_PI.md`](DEPLOY_PI.md) instead. This runbook is for the
shack-control Pi itself.

**Estimated time:** ~90 minutes from blank SD card to fully working
shack, assuming reasonable internet and existing GitHub SSH keys.

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
sudo raspi-config nonint do_serial_hw 0   # enable hardware UART (rotor / SPE)

# Verify I²C bus
ls /dev/i2c-1                              # should exist
sudo i2cdetect -y 1                        # AS3935 should appear at 0x03 (or 0x01/0x02)
```

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
  node-red-node-serialport \
  node-red-contrib-flexradio \
  node-red-contrib-ui-svg \
  node-red-node-ping \
  node-red-configurable-ping \
  node-red-node-rbe \
  node-red-contrib-loop \
  node-red-contrib-ui-level
```

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

### Set up the `nrsave` git alias

```bash
git -C ~/.node-red/projects/vu2cpl-shack config alias.save '!f() { git add flows.json && git commit -m "$1"; }; f'
# Test:
nrsave () { git -C ~/.node-red/projects/vu2cpl-shack save "$1"; }
echo 'nrsave () { git -C ~/.node-red/projects/vu2cpl-shack save "$1"; }' >> ~/.bashrc
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

# Enable + start the two services
sudo systemctl enable --now as3935 rpi-agent
sudo systemctl status as3935 --no-pager
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

## Step 10 — DXCC + Telegram credentials

Open Node-RED → DXCC Tracker tab → **`⚙️ Credentials`** node
(`08dcd5378a79bb18`). Paste your current Club Log API key, email,
password, callsign, and Telegram bot token / chat_id. These are
**not** in the repo — they were rotated and stored only on the
working Pi.

```javascript
var cfg = {
    cl_apikey   : '<your-club-log-api-key>',
    cl_email    : 'vu2cpl@gmail.com',
    cl_password : '<your-club-log-password>',
    cl_callsign : 'VU2CPL',
    tg_token    : '<your-telegram-bot-token>',
    tg_chat_id  : '<your-telegram-chat-id>'
};
```

Click Done → **Full Deploy**.

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

---

## Step 12 — Final verification

A 12-point checklist. Hit each one.

| # | Check | Pass criterion |
|---|-------|----------------|
| 1 | Pi reachable at `192.168.1.169` | `ping -c 3 192.168.1.169` from Mac |
| 2 | Node-RED editor loads | Browser → `http://192.168.1.169:1880` |
| 3 | Dashboard loads | Browser → `http://192.168.1.169:1880/ui` |
| 4 | All 11 flow tabs deploy clean | No red triangles on tab labels |
| 5 | MQTT broker alive | `mosquitto_sub -h localhost -t '#' -C 5` shows traffic |
| 6 | AS3935 daemon publishing | Topic `lightning/as3935/hb` ticks every 30 s |
| 7 | RPi telemetry publishing | Topic `rpi/noderedpi4/cpu` updates every 60 s |
| 8 | LP-700 telemetry alive | Dashboard LP-700 panel shows live values |
| 9 | FlexRadio TCP up | Dashboard FlexRadio panel shows slice state |
| 10 | Tasmota state sync | Toggle a power outlet from dashboard → relay clicks → state syncs back |
| 11 | DXCC alerts firing | DXCC tab status badges green; spots arriving in the table |
| 12 | Lightning auto-disconnect | Click `TEST ⚡ 6 km DISCONNECT` inject → antenna + radio go OFF |

If 1–7 pass but 8 fails: re-check Step 9 (lp700-server install).
If 11 fails: re-check Step 10 (credentials node) and the file context store.

---

## Common failure modes

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `nrsave` reports "nothing to commit" after every Deploy | Projects feature not enabled, flows.json not in the project dir | Re-do Step 4's projects block + Step 5 |
| AS3935 daemon starts but counters never increment | IRQ wired to wrong GPIO | Re-check pin 7 / GPIO4 (Step 8) |
| Mosquitto refuses connections from Tasmota devices | Default config bound to localhost only | Re-do Step 3's `lan.conf` |
| Node-RED can't open USB serial | User not in `dialout` group | `sudo usermod -aG dialout vu2cpl` then re-login |
| LP-700 dashboard frozen at one value | aggregator reading wrong msg shape (the 2026-05-09 fix) | The repo already has the fix; if you see this on a fresh clone, double-check `git pull` actually landed |
| `flow.set('foo', 'file')` not persisting | File context store not enabled | Re-run `enable_file_context.sh` (Step 6) |

---

## Files referenced by this runbook

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
