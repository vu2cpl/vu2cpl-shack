# CLAUDE.md — VU2CPL Shack Automation
**Operator:** Manoj (VU2CPL) | MK83TE | Bengaluru, India
**Repo:** github.com/vu2cpl/vu2cpl-shack (private)
**Last updated:** April 2026

---

## RUNTIME ENVIRONMENT

Claude Code runs on **Mac Mini M4 Pro** with a local clone of the repo.

| Detail | Value |
|--------|-------|
| Local repo | `~/projects/vu2cpl-shack/` |
| Mac hostname | `MiniM4-Pro` |
| Pi SSH | `ssh vu2cpl@192.168.1.169` |
| SwiftUI app (planned) | `~/projects/vu2cpl-shack-app/` |
| Website source | `~/projects/vu2cpl-website/` (vu2cpl.com staging) |
| GitHub Pages site | `~/projects/vu2cpl.github.io/` |

**Claude Code cannot directly access the Pi.** Any changes to `flows.json` must be:
1. Edited locally
2. `git push` from Mac
3. On Pi: `git pull` then `sudo systemctl restart nodered`

For quick Node-RED flow edits, prefer the browser editor + `nrsave` on Pi directly.
Use Claude Code on Mac for:
- SwiftUI app development (`~/projects/vu2cpl-shack-app/`)
- Generating function node code to paste into Node-RED
- Documentation, README, analysis
- Flow JSON review and planning

**To apply a flows.json change on Pi after push:**
```bash
ssh vu2cpl@192.168.1.169
cd ~/.node-red/projects/vu2cpl-shack
git pull
sudo systemctl restart nodered
```

---

## CRITICAL RULES — READ FIRST

1. **Never generate or output a Node-RED flow JSON** unless Manoj explicitly confirms he wants it. Always propose changes first, describe what will change, wait for approval.
2. **Node IDs are NOT stable** across import/redeploy. Never hardcode an ID from memory. Match nodes by name, type, or tab label when inspecting flows.
3. **When updating `DXCC.md`**, always regenerate `DXCC_Tracker_README.pdf` and commit both together. They must stay in sync. (Pre-2026-05-10: this rule applied to `README.md`, which was the DXCC doc; now `README.md` is the umbrella overview and `DXCC.md` is the DXCC reference.)
4. **On every git commit**, extract the DXCC Tracker tab alongside flows.json:
   ```bash
   python3 -c 'import json; d=json.load(open("flows.json")); v=[n for n in d if n.get("z")=="d110d176c0aad308" or n.get("id")=="d110d176c0aad308"]; json.dump(v,open("clublog_dxcc_tracker_v7.json","w"),indent=2)'
   git add flows.json clublog_dxcc_tracker_v7.json
   ```
5. **Never put file upload instructions inside index.html** (vu2cpl.com website). Give them as chat instructions only.

---

## PROJECT OVERVIEW

Node-RED shack automation running on Raspberry Pi 4B. Controls and monitors:
- FlexRadio FLEX-6600 SDR transceiver
- SPE Expert 1.5 KFA amplifier
- Idiom Press Rotor-EZ rotator
- Telepost LP-700 power/SWR meter (via [VU3ESV/LP-700-Server](https://github.com/VU3ESV/LP-700-Server) WebSocket gateway on port 8089)
- 21 Tasmota-controlled power outlets across 5 devices
- Lightning protection (Open-Meteo + AS3935 sensor)
- DX cluster monitoring and DXCC alerting
- Raspberry Pi fleet monitoring

**Future:** Native macOS SwiftUI menu-bar app replacing the browser dashboard (see Mac App section).

---

## INFRASTRUCTURE

| Component | Detail |
|-----------|--------|
| Node-RED host | Raspberry Pi 4B, hostname `noderedpi4` |
| SSH | `ssh vu2cpl@192.168.1.169` |
| Flows file | `~/.node-red/projects/vu2cpl-shack/flows.json` |
| Node-RED dashboard | `http://192.168.1.169:1880/ui` |
| Node-RED editor | `http://192.168.1.169:1880` |
| MQTT broker | Mosquitto @ `192.168.1.169:1883` (plain, no auth, LAN only) |
| MQTT broker node ID | `f4785be9863eab08` |
| FlexRadio | `192.168.1.148:4992` (TCP API + UDP discovery) |
| LP-700 WS gateway | `lp700-server.service` on Pi @ `ws://192.168.1.169:8089/ws` (single HID owner, multi-client fan-out) |
| Git alias | `nrsave "message"` → add flows.json + commit |
| Dashboard theme | Dark, base #097479, bg #111111 |

### Restart Node-RED
```bash
sudo systemctl restart nodered
```

### Save changes
```bash
# After Deploy in Node-RED editor:
nrsave "description of change"
git push
```

---

## FLOW TABS (11 total)

| Tab Label | Tab ID | Nodes | Dashboard Group |
|-----------|--------|-------|-----------------|
| SPE | `648eb83c2566c7b6` | 29 | `vu2cpl_grp_spe` |
| Rotor | `3d26c2c5270bdb37` | 24 | `84143f78d088f01d` |
| FlexRadio | `a0a882f85c89cffc` | 43 | `vu2cpl_grp_flex` |
| LP-700-HID ws | `18fb42443172f33c` | 18 | `vu2cpl_grp_lp700` |
| Solar | `590e889d44815afb` | 35 | `vu2cpl_grp_solar` |
| RBN Skimmer Monitor | `f9a0e3ad0e019052` | 32 | `1bcbc2eb8f2124aa` |
| RPi Fleet Monitor | `d5fec2fea3dd37f4` | 27 | `f8d1f7eb7403a442` |
| Internet and network monitor | `b05f8c028b368ae9` | 26 | `f10110e00bae2689` |
| Lightning Antenna Protector | `75e2cac8ab96f556` | 71 | `grp_main` |
| All Power Strips | `b76a5310767803b4` | 45 | `vu2cpl_grp_power` / `vu2cpl_grp_energy` |
| DXCC Tracker | `d110d176c0aad308` | 70 | `grp_dxcc_stats` |

### Dashboard tabs

| Name | ID | Order |
|------|----|-------|
| VU2CPL Shack | `vu2cpl_ui_tab_shack` | 1 |
| Lightning detect and disconnect | `dd11372f9c492be8` | 3 |
| Shack Monitoring tools | `bcce4e07ac31b882` | 4 |
| DXCC Tracker | `tab_ui_dxcc` | 5 |

---

## HARDWARE MAP

### Tasmota Power Devices (MQTT broker 192.168.1.169:1883)

| Device | Outlets | Assignment |
|--------|---------|------------|
| `powerstrip1` | POWER1 | 13.8V SMPS |
| | POWER2 | **Rotator** (auto-off timer) |
| | POWER3 | Plug 3 |
| | POWER4 | Plug 4 |
| | POWER5 | **Antenna switch** (lightning) |
| `powerstrip2` | POWER1-5 | General outlets |
| `powerstrip3` | POWER1 | LZ1AQ Loop |
| | POWER2-5 | General outlets |
| `4relayboard` | POWER1 | **Flex Radio ON** (lightning) |
| | POWER2 | Flex PTT |
| | POWER3-4 | Spare relays |
| `16Amasterswitch` | POWER1 | 16A mains (energy monitoring, TelePeriod=30s) |

### USB Serial Devices (stable /dev/serial/by-id paths)

| Device | Path | Baud |
|--------|------|------|
| SPE Expert 1.5 KFA | `usb-FTDI_FT232R_USB_UART_AI040UZR-if00-port0` | 57600-8N1 |
| SPE (alternate) | `usb-FTDI_FT232R_USB_UART_AI040V80-if00-port0` | 115200-8N1 |
| Rotor-EZ | `usb-FTDI_FT232R_USB_UART_AL05J29R-if00-port0` | 4800-8N1 |

### USB HID

| Device | VID | PID | Group | Owner |
|--------|-----|-----|-------|-------|
| LP-700 / LP-500 | 0x04D8 (1240) | 0x0001 (1) | telepost | `lp700-server.service` (Go, owns `/dev/hidraw*`); Node-RED is a WS client |
| udev rules | `/etc/udev/rules.d/10-telepost.rules` (legacy, still in place); `/etc/udev/rules.d/99-lp700.rules` (installed by lp700-server's `redeploy.sh`) | | | |

### RPi Fleet (HTTP agent port 7799)

| Hostname | User | Status |
|----------|------|--------|
| `noderedpi4` | `vu2cpl` | Agent running |
| `openwebrxplus` | `vu2cpl` | Agent running |
| (2 more Pis) | — | Pending |
| Home Assistant Pi | — | Pending — HA REST API Bearer token |

Agent endpoints: `POST /reboot`, `POST /shutdown`

---

## KEY NODE IDs

> **Warning:** IDs can change on reimport. Verify by name if something breaks.

### Lightning Antenna Protector (`75e2cac8ab96f556`)

| ID | Name | Role |
|----|------|------|
| `ec1fd4dece8c4dc0` | Init Defaults ✏️ EDIT HERE | All config — edit this node |
| `557083037f168b22` | Master Dashboard | Main ui_template |
| `26ddff0cbbfe5fc1` | Parse Strike | Parses lat/lon from payload |
| `86dae31ff50fe297` | Haversine Distance | Calculates distance from home |
| `d62fb0c3c40f03b7` | Trigger Disconnect | Sends MQTT OFF, starts timer |
| `dabc283d78fa8081` | Reconnect Timer | setTimeout, resets on new strike |
| `bfbe99e98a8c6ce8` | Execute Reconnect | Sends MQTT ON after clear |
| `593f22a507b46335` | Parse Open-Meteo → Strike | index → synthetic km |
| `c6d09b384716b54c` | Parse Weather → Header | 2 outputs: Header + Dashboard |
| `eee1a8b8552aa21f` | Header — Clocks + Weather | ui_template on Shack tab |
| `b2e2ed6a2bba24af` | Tasmota Antenna Switch | mqtt out |
| `9b4f3f603a7ab65f` | Tasmota Radio Switch | mqtt out |
| `0a664ba977970e17` | Parse AS3935 | 3 outputs: lightning/disturber/noise |
| `d1dca3df391cdfb8` | Stats → Dashboard | Flow state → dashboard |
| `f2092c6e0d932c7b` | HTTP → Antenna ON | Handles /lightning/ant-on |
| `f5b66018bf5eedd9` | HTTP → Radio ON | Handles /lightning/radio-on |

### DXCC Tracker (`d110d176c0aad308`)

| ID | Name | Role |
|----|------|------|
| `08dcd5378a79bb18` | ⚙️ Credentials (edit once) | API keys, tokens, paths |
| `38a6451a95a57685` | DXCC Dashboard | Main ui_template |
| `b981643f37259f89` | DXCC Prefix Lookup + Alert Classify | Core classification logic |
| `1a13cd6d9aabaa54` | Bootstrap Worked Table | Loads from file store / seed |
| `9fd52c02a8486dce` | Fetch All Modes + Parse | Club Log API fetch |
| `6e60f619acad462e` | Build Club Log API Request | Builds API URL |
| `bf47f506a324b481` | Blacklist Manager | Manages blocked callsigns |
| `2286f0a512733e92` | Format Alert for Dashboard Table | Alert HTML formatting |
| `login-parse-dedup-v2` | Login + Parse + Dedup | 3 outputs: spot/cluster_status/dedup |
| `c68f81fda8c7f015` | Cluster Watchdog | Monitors cluster last-seen |

### All Power Strips (`b76a5310767803b4`)

| ID | Name | Role |
|----|------|------|
| `780b75182df31634` | Power Control Panel | Main ui_template, fwdInMessages=false |
| `f8c3c072b381bd1c` | Power State → Dashboard | rotatorTimerEnd check BEFORE payload guard |
| `05f0ddeb566a90fc` | Rotator Auto-Off Timer | Auto-off on powerstrip1/POWER2 |
| `f04c617be19bb21d` | stat/powerstrip1/POWER2 (Rotator) | mqtt in for rotator |
| `a1fbb636a745e687` | Power TOGGLE Router | Routes toggle commands |
| `e72813d4b7791246` | Energy Aggregator | 16A energy data |

### FlexRadio (`a0a882f85c89cffc`)

| ID | Name | Role |
|----|------|------|
| `de6b988cbc7182ca` | Flex State Aggregator | Central state manager, flexState context |
| `bf129ed26ea2ca5f` | FlexRadio Panel | ui_template, AngularJS bindings |

### RPi Fleet Monitor (`d5fec2fea3dd37f4`)

| ID | Name | Role |
|----|------|------|
| `a0695975fec84e2c` | Route CMD: HTTP or MQTT | Routes reboot/shutdown |
| `9e23f3f53a585119` | RPi CMD to MQTT | MQTT fallback |
| `e272ebba783d8b74` | RPi Fleet Panel | ui_template with confirmation modal |

---

## HTTP ENDPOINTS

| Method | Path | Tab | Purpose |
|--------|------|-----|---------|
| POST | `/lightning/ant-on` | Lightning | Force antenna ON |
| POST | `/lightning/radio-on` | Lightning | Force radio ON |
| POST | `/lightning/threshold` | Lightning | Save disconnect distance |
| POST | `/lightning/reconnect` | Lightning | Save reconnect timer |
| GET | `/dxcc/stats` | DXCC | Return current stats |
| GET | `/dxcc/blacklist` | DXCC | Return blacklist |
| POST | `/dxcc/filters` | DXCC | Save alert filter settings |
| POST | `/dxcc/refresh` | DXCC | Trigger Club Log re-fetch |
| POST | `/dxcc/clear` | DXCC | Clear alert table |
| POST | `/dxcc/blacklist-add` | DXCC | Add callsign to blacklist |
| POST | `/dxcc/blacklist-remove` | DXCC | Remove from blacklist |

---

## CODING PATTERNS

### Dashboard interactions
Always use `fetch()` + `http-in` — never `send()` or `ng-click`:
```javascript
// In ui_template:
window._myAction = function(val) {
  fetch('/my/endpoint', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({value: val})
  });
};

// http-in node → function node → http response node (200)
```

### Telegram HTTP request node
URL field must be **blank**. Set `msg.url` in the upstream function node.
Newer Node-RED blocks `msg.url` override if URL field is populated.

### Power State → Dashboard
The `rotatorTimerEnd` check must come **BEFORE** the payload guard:
```javascript
// CORRECT order in Power State → Dashboard:
if (msg.rotatorTimerEnd !== undefined) { ... }  // FIRST
if (!msg.topic) return null;                     // SECOND
```

### fwdInMessages
Power Control Panel (`780b75182df31634`) must have `fwdInMessages: false`.
Setting it to true causes all-plug flickering via feedback loop.

### Full Deploy
After editing FlexRadio TCP nodes or MQTT broker config nodes, always use
**Full Deploy** (not Modified Flows) to force reconnection.

### Large function nodes
Use the full-screen editor (expand ↗ button) for any function node with 50+
lines. The inline editor silently truncates content.

### Master Dashboard message types
All data to Master Dashboard (`557083037f168b22`) uses typed payloads:
```javascript
{type: 'weather',      wx: wxData}
{type: 'strike',       lat, lon, km, color, ...}
{type: 'stat_ant',     on: bool}
{type: 'stat_radio',   on: bool}
{type: 'as3935_status', event, timestamp}
{type: 'clear'}
{type: 'log',          html: '...'}
// Stats: no type field, has threshold_km
```

Weather data to Header template (`eee1a8b8552aa21f`): plain `wxData` object (no type wrapper).

---

## FLOW-SPECIFIC NOTES

### Lightning Antenna Protector
- **Init Defaults** node is the single config point — edit only this node
- Open-Meteo index mapping: `km = (1 - index/100) * 200` (index < 5 dropped)
- AS3935 MQTT topic: `lightning/as3935`, payload: `{event, distance, energy, timestamp}`
- AS3935 distance 63 = out of range → treated as 0 km (always disconnect)
- Weather: Parse Weather has 2 outputs — output 1 → Header (plain wxData), output 2 → Master Dashboard ({type:'weather'})

### DXCC Tracker
- **Credentials node** (`08dcd5378a79bb18`): set `cl_apikey`, `cl_email`, `cl_password`, `cl_callsign`, `tg_token`, `tg_chat_id`, `cfg_flows_dir`
- `cfg_flows_dir` = `os.homedir() + '/.node-red/projects/vu2cpl-shack'`
- Confirmed logic: `bands[mk] >= 2` (Club Log value 2=confirmed, 1=worked only, 3=eQSL only=unconfirmed)
- Alert types: NEW_DXCC (red), NEW BAND (blue), NEW MODE (amber), NEW_BAND_UNCONF (blue dim), NEW_MODE_UNCONF (amber dim)
- Dedup window: 60 seconds per callsign+frequency
- Startup sequence: 0.5s Credentials → 2s Bootstrap → 5s cty.xml → 12s Club Log → 90s retry
- Data files (must exist in `cfg_flows_dir`):
  - `nr_dxcc_maps.json` — prefix → DXCC entity map
  - `nr_dxcc_seed.json` — worked/confirmed data (update after DXpeditions)
  - `nr_dxcc_modes.json` — per-entity CW/Ph/Data mode data
  - `nr_dxcc_blacklist.json` — blocked callsigns
- Context store must be configured with `file` module in settings.js
- DX Clusters: N2WQ (`cluster.n2wq.com:8300`), VU2OY (`vu2oy.ddns.net:7550`), VU2CPL (`vu2cpl.ddns.net:7550`), VE7CC (`ve7cc.net:23`)

### All Power Strips (Rotator)
- Rotator timer node (`05f0ddeb566a90fc`): currently `60 * 1000` (1 min) — **change to `5 * 60 * 1000` for production**
- Timer does NOT survive Node-RED restart — acceptable for rotator use

### FlexRadio
- All slice state in `flexState` flow context
- Split mode known issue: both slices report `tx:1` in split mode. RX slice has `active:1`, TX has `active:0`. Coloring for split mode **deferred**.
- `clientHandleMap` built from discovery message (`gui_client_handles` + `gui_client_stations`)

### SPE Amplifier
- 250ms poll cycle, 76-byte fixed frame, checksum + wraparound validation
- Power-on requires external Python: `python3 ~/power_spe_on.py`
- CSV logging enabled

### RPi Fleet Monitor

> **Full per-Pi onboarding runbook** with verification + troubleshooting:
> see [`DEPLOY_PI.md`](DEPLOY_PI.md). The notes below are quick-reference.

Per-Pi setup splits into **two independent components** — one for control,
one for telemetry. Both check into this repo (root level).

- **Telemetry topics** (published by `monitor.sh`):
  `rpi/<hostname>/{cpu,temp,mem,disk,uptime,ip,status}`
- **Alerts** (in Node-RED flow): CPU >90%, Temp >75°C, Mem >90%, Disk >90%

#### 1. HTTP control agent — `rpi_agent.py`

Listens on `:7799` for `POST /reboot` and `POST /shutdown`. Pure stdlib;
no telemetry, no MQTT. Runs as systemd service.

```bash
# On the new Pi:
sudo cp rpi_agent.py /home/vu2cpl/
sudo cp rpi-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rpi-agent
# Sudoers (one-time): allow vu2cpl to reboot/shutdown without password
echo 'vu2cpl ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown' | \
  sudo tee /etc/sudoers.d/rpi-agent
sudo chmod 440 /etc/sudoers.d/rpi-agent
```

Then add the host to `httpDevices` in the "Route CMD: HTTP or MQTT"
node (`a0695975fec84e2c`).

#### 2. Telemetry publisher — `monitor.sh`

Reads CPU / mem / temp / disk / uptime / IP and `mosquitto_pub`s each as
a separate topic. Cron-driven, every minute, from the user's crontab.

```bash
# On the new Pi:
sudo cp monitor.sh /home/vu2cpl/
sudo chmod +x /home/vu2cpl/monitor.sh
# Confirm mosquitto-clients is installed for mosquitto_pub:
sudo apt install -y mosquitto-clients
# Append to user crontab (`crontab -e` as vu2cpl):
* * * * *  /home/vu2cpl/monitor.sh
```

#### Home Assistant Pi (special case)

HA Pi (`HassPi`) uses neither script. HA-side automation publishes the
same `rpi/HassPi/*` topics directly via HA's `mqtt.publish` service every
30 s. No Node-RED flow changes needed for HA Pi onboarding.

---

## EXTERNAL APIs

| Service | URL | Rate / Key |
|---------|-----|------------|
| Open-Meteo lightning | `api.open-meteo.com/v1/forecast?hourly=lightning_potential` | 5 min, free |
| Open-Meteo weather | `api.open-meteo.com/v1/forecast` (current + hourly) | 10 min, free |
| NOAA Scales | `services.swpc.noaa.gov/products/noaa-scales.json` | 15 min, free |
| NOAA F10.7 | `services.swpc.noaa.gov/json/f107_cm_flux.json` | 15 min, free |
| NOAA Geomagnetic | `services.swpc.noaa.gov/text/daily-geomagnetic-indices.txt` | 15 min, free |
| GOES X-ray | `services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json` | 5 min, free |
| MUF/foF2 | `prop.kc2g.com/api/point_prediction.json?grid=13.065,77.806` | 15 min, free |
| Club Log DXCC | `clublog.org/json_dxccchart.php` | Daily, requires key |
| RBN calibration | `sm7iun.se/rbnskew.csv` | 6h, free |

---

## NODE-RED PALETTE PACKAGES

```
node-red-dashboard           3.6.6
node-red-node-serialport     2.0.3
node-red-contrib-flexradio   1.2.5
@gdziuba/node-red-usbhid     1.0.3  (LEGACY — installed; LP-700 now uses WS gateway, no longer needed)
node-red-contrib-ui-svg      2.3.3
node-red-node-ping           0.3.3
node-red-configurable-ping   1.0.1
node-red-node-rbe            latest
node-red-contrib-loop        latest
node-red-contrib-ui-level    latest
```

HID package and its build deps are no longer required (LP-700 migrated to
the WS gateway 2026-05-09). Both are still present for now — uninstall once
the WS path is proven stable for a week:

```bash
# When ready to clean up:
cd ~/.node-red && npm uninstall @gdziuba/node-red-usbhid
sudo apt remove libudev-dev librtlsdr-dev libusb-1.0-0-dev
```

Original install reference (kept for archaeology):
```bash
cd ~/.node-red && npm install robertsLando/node-red-contrib-usbhid
# Prereqs: libudev-dev librtlsdr-dev libusb-1.0-0-dev
```

---

## MAC APP (in progress)

**Goal:** Native macOS SwiftUI menu-bar app replacing the browser dashboard.

| Detail | Value |
|--------|-------|
| Project folder | `~/projects/vu2cpl-shack-app/` |
| Spec file | `CLAUDE.md` (in project folder) |
| Target | macOS 14.0+ (Sonoma), Apple Silicon |
| MQTT library | CocoaMQTT |
| FlexRadio | `Network.framework` NWConnection (no third-party lib) |

**5 tabs:** Power Control · Radio (FlexRadio) · Solar · Lightning · Settings

**Menu bar:** icon changes colour for TX state / lightning alert, popover for quick status

**Build order:**
1. Xcode scaffold + MQTTManager + Power Control tab
2. NSStatusItem + popover
3. FlexRadioManager + Radio tab
4. NOAAService + OpenMeteoService + Solar tab
5. Lightning tab + auto-disconnect logic
6. UNUserNotificationCenter notifications

**To start:**
```bash
cd ~/projects/vu2cpl-shack-app
claude
# First message: "Read CLAUDE.md and scaffold the Xcode project."
```

**Data sources the app needs (same as Node-RED flows):**
- MQTT `192.168.1.169:1883` — all Tasmota state, RPi telemetry, AS3935
- FlexRadio TCP `192.168.1.148:4992` — slice state, TX, meters
- Open-Meteo — weather + lightning potential
- NOAA APIs — solar indices
- HTTP endpoints above — for control actions

---

## OPEN BUGS / PENDING TODO

| # | Item | Status |
|---|------|--------|
| 1 | AetherSDR v0.8.11 MQTT bug — TLS reset on plain port 1883 | Open, upstream fix awaited |
| 2 | FlexRadio split mode coloring (both slices tx:1, use active field) | Deferred |
| 3 | Rotator timer: change `60 * 1000` → `5 * 60 * 1000` in Rotator Auto-Off Timer | **PENDING** |
| 4 | RPi agent deploy on 2 remaining Pis + HA Pi (Bearer token) | Pending |
| 5 | Website: upload shack.jpg, VU7MS/VU7T PDFs | Pending |
| 6 | DXCC: filter persistence (file context store) | Pending |
| 7 | DXCC: CW/Ph/Data separate fetch modes | Pending |
| 8 | DXCC: non-project folder path support | Pending |
| 9 | DXCC: README + PDF commit | **Done 2026-05-10** (split into README.md umbrella + DXCC.md, PDF regenerated) |
| 10 | DXCC: verify Club Log API ban status + re-enable nodes if lifted | Pending |
| 11 | DXCC: verify daily 02:00 inject wired to Build Club Log API Request | **Verified 2026-05-10** — the cron `00 02 * * *` is correctly wired to `Build Club Log API Request`. The `once: false` on `Load Club Log on startup` + `Retry Club Log (90s)` is **intentional** (anti-ban; see TODO #10). Bootstrap-sets-dxccReady fix (also 2026-05-10) makes startup independent of any Club Log API call. |
| 12 | Mac SwiftUI app: scaffold not yet started | Pending |

---

## GIT WORKFLOW

```bash
# Save after any Deploy:
nrsave "description"   # runs: cd ~/.node-red/projects/vu2cpl-shack && git add flows.json && git commit -m
git push

# Full commit with DXCC tab extract:
cd ~/.node-red/projects/vu2cpl-shack
python3 -c 'import json; d=json.load(open("flows.json")); v=[n for n in d if n.get("z")=="d110d176c0aad308" or n.get("id")=="d110d176c0aad308"]; json.dump(v,open("clublog_dxcc_tracker_v7.json","w"),indent=2)'
git add flows.json clublog_dxcc_tracker_v7.json
git commit -m "v7: description"
git push

# Rollback:
git revert HEAD                           # safe, keeps history
git checkout <id> -- flows.json           # restore specific version
sudo systemctl restart nodered            # always after manual file changes

# View history:
git log --oneline
```

---

## BACKUP

```bash
TS=$(date +%Y%m%d_%H%M)
tar -czf ~/nr_backup_$TS.tar.gz \
  ~/.node-red/projects/vu2cpl-shack/flows.json \
  ~/.node-red/projects/vu2cpl-shack/nr_dxcc_*.json \
  ~/.node-red/settings.js \
  ~/power_spe_on.py
```

Critical files:
- `flows.json` — main flows
- `nr_dxcc_maps.json` — prefix map
- `nr_dxcc_seed.json` — worked data (update after QSOs)
- `nr_dxcc_modes.json` — mode data
- `~/.node-red/settings.js`

Pi-side scripts already in this repo (canonical paths shown):

| Script in repo | Deployed path on Pi | Purpose |
|----------------|---------------------|---------|
| `as3935_mqtt.py` | `/home/vu2cpl/as3935_mqtt.py` | AS3935 chip daemon — `as3935.service` |
| `as3935.service` | `/etc/systemd/system/as3935.service` | systemd unit for the AS3935 daemon |
| `as3935_tune.py` | `/home/vu2cpl/as3935_tune.py` | LC-tank TUN_CAP sweep helper |
| `rpi_agent.py` | `/home/vu2cpl/rpi_agent.py` | HTTP reboot/shutdown — `rpi-agent.service` |
| `rpi-agent.service` | `/etc/systemd/system/rpi-agent.service` | systemd unit for rpi_agent |
| `monitor.sh` | `/home/vu2cpl/monitor.sh` | MQTT telemetry cron (every minute) |
| `power_spe_on.py` | `/home/vu2cpl/power_spe_on.py` | SPE Expert 1.5 KFA power-on via FTDI DTR/RTS toggle |
| `enable_file_context.sh` | `/home/vu2cpl/enable_file_context.sh` | One-time idempotent settings.js patcher to enable Node-RED `localfilesystem` context store |

For a full from-scratch rebuild of this Pi (blank SD card → working
shack), see [`REBUILD_PI.md`](REBUILD_PI.md). For onboarding a
*different* Pi as a fleet member (just telemetry + reboot agent),
see [`DEPLOY_PI.md`](DEPLOY_PI.md).

---

*73 de VU2CPL*
