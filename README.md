# VU2CPL Shack Automation

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Node-RED flows + supporting scripts that automate the VU2CPL amateur
> radio shack: lightning protection, power control, radio + amplifier
> telemetry, solar conditions, DXCC alerting, and Pi fleet monitoring.

VU2CPL · Manoj · Bengaluru · MK83TE · Licensed 1993 · 9× BDXCC

---

## Overview

A single Node-RED instance on a Raspberry Pi 4B (`noderedpi4`,
`192.168.1.169`) hosts 11 flow tabs and one consolidated Shack
dashboard. Hardware talks to Node-RED via:

- **MQTT** (Mosquitto on the same Pi) — Tasmota power outlets, AS3935
  lightning sensor, RPi telemetry, UberSDR receiver metrics, OpenWebRX+
  listeners and per-receiver health (`shack/openwebrx/*`, RSP2 + MSi2500).
  **Authenticated** (anonymous disabled 2026-08-21) — role accounts
  `iot`/`svc`/`nodered`/`ha`/`display` with per-account ACLs; see
  [`MQTT_AUTH.md`](MQTT_AUTH.md). The read-only `display` account feeds
  the AetherSDR panadapter status overlay via a Node-RED humanizer flow
  ([`nodered/aether-display/`](nodered/aether-display/)).
- **Direct TCP/UDP** — FlexRadio (4992), DX clusters
- **Serial** — SPE amplifier (via `spe-remote` gateway)
- **WebSocket** — LP-700 power/SWR meter (via the
  [`lp700-server`](https://github.com/VU3ESV/LP-700-Server) gateway) and
  Rotor-EZ rotator (via the
  [`rotator-remote`](https://github.com/vu2cpl/rotator-remote) gateway)
- **HTTP** — Open-Meteo, NOAA SWPC, Club Log, RPi fleet agent

**Two dashboards**, both served by the same Node-RED instance:

- **`/ui`** — Dashboard 1 (legacy Angular). Dark-themed
  (base `#097479`, bg `#111111`). Original, all features intact.
- **`/shack`** — Vue 3 SPA served via uibuilder. 14 cards, all
  collapsed by default with live summary headers, true responsive
  layout (CSS column masonry), PWA-installable on iPad / iPhone
  ("Add to Home Screen"). The primary dashboard going forward.
  Cards are individually toggleable via a `const CARDS = { … }` block
  at the top of `uibuilder/shack/src/index.js` (`v-if` per card) — a
  forker who lacks a subsystem hides its card without deleting any
  code; `rebuild_pi.sh` Stage 13 sets these from a hardware Y/n
  round. See SHACK_CHANGELOG `2026-06-04`.

A 2026-05-24 POC of Dashboard 2 (`@flowfuse/node-red-dashboard`,
served at `/dashboard`) was retired on 2026-05-26 in favour of
uibuilder + Vue. See SHACK_CHANGELOG `2026-05-26` for the retirement
rationale.

Since 2026-08-25 there is also a **Home Assistant satellite view**:
the HA "Radio" dashboard (on the household HA instance) mirrors the
whole Vue card set with stock HA cards, across two tabs — Radio
(operating) and Fleet (monitoring). The MQTT-native subsystems —
Power, Solar, House Loads, Lightning, RPi Fleet, GPS NTP, Network,
UberSDR — ride the shack's existing topics through retained
MQTT-discovery configs published by `ha_discovery_publish.py`, needing
no Node-RED changes at all. The gateway-backed ones (FlexRadio, SPE,
LP-700, Rotator, DXCC, RBN) followed the same day over **read-only
Node-RED → MQTT state bridges**: per tab, an inject tick → a function
reading that tab's existing context → a retained
`shack/<subsystem>/state`, touching no flow behaviour. Lightning and
the rotator also carry controls, via HA `rest_command`s onto the same
HTTP endpoints the dashboards use. One caveat: the DXCC card goes
blank while the DXCC Tracker flow tab is disabled — it has been since
2026-08-27 — because that tab's bridge stops with it.

---

## Hardware

| Item | Detail |
|------|--------|
| Radio | FlexRadio FLEX-6600, RGO One, Icom IC-705 |
| Amplifier | SPE Expert 1.5 KFA |
| Antennas | Hex beam, 160 m inverted-L, 6 m LFA Yagi, Beverage / N6RK / K9AY receive |
| Power | 21 Tasmota-controlled outlets across 5 shack devices, plus 4 house-load Tasmota circuits (FF/GF load, dryer-kitchen, utility — HA's load-shedding relays — battery-SOC since 2026-05, and grid-loss overload shedding of utility + dryer-kitchen added 2026-10-19, all grid-loss shedding off since 2026-10-25 — toggleable from the Power card) |
| Solar | Deye SG0*LP3 LV 3-phase hybrid inverter, read locally via its Solarman WiFi logger (no cloud, no Home Assistant in the path) |
| Power meter | Telepost LP-700 (USB HID, owned by `lp700-server` on the Pi) |
| Rotator | Yaesu (rotates past 360° into an overlap zone) behind an Idiom Press Rotor-EZ / DCU-1 serial interface |
| Lightning | AS3935 sensor on ESP-WROOM-32 bridge → WiFi → MQTT (see [`vu2cpl-as3935-bridge`](https://github.com/vu2cpl/vu2cpl-as3935-bridge)) + Open-Meteo CAPE polling. Indoor Pi-side daemon retained as standby fallback |
| Awards | 9× BDXCC |
| DXpeditions | VU7T, VU7MS (Lakshadweep), AT5P (Rameshwaram) |
| Grid | MK83TE — Bengaluru |
| Licensed | Since 1993 |

---

## Subsystems

Eleven flow tabs, each handling one logical subsystem. Detailed node
IDs, function bodies, and operational quirks live in
[`CLAUDE.md`](CLAUDE.md). The summaries below are "what + why".

### Lightning Antenna Protector

Auto-disconnects the antenna and radio when lightning is detected
within a configurable threshold (default 25 km). Two strike sources:

- **Open-Meteo CAPE polling** every 5 min — synthesises a strike
  distance from CAPE values and WMO weather codes (95/96/99 = thunderstorm).
- **AS3935 chip** sensor — rated ~40 km range. Bridged onto MQTT by an
  ESP-WROOM-32 ([`vu2cpl-as3935-bridge`](https://github.com/vu2cpl/vu2cpl-as3935-bridge),
  v0.2.0). Indoor `as3935.service` on the Pi is retained as standby
  fallback. Installed outdoors 2026-07-31 (sealed enclosure,
  18650+TP4056+solar power chain, shade mount, TUN_CAP retuned) — off
  the bench and back to its full rated range.

A vertical **BYPASS** switch on the dashboard suspends auto-disconnect
for 120 minutes (force-reconnects ant + radio on activation, never
survives a Node-RED restart). The alert banner always shows current
state with a muted "Last: …" recap after 30 s of silence. Reconnect
fires automatically after a configurable clear period (default 20 min)
once the storm passes.

**Event logging:** Strike events (including disconnect/reconnect transitions
and sensor status changes) are persisted to `nr_lightning_events.jsonl` in
the flows directory. The path is configured in the **Init Defaults** node
(`ec1fd4dece8c4dc0`) on the Lightning tab and survives Node-RED restarts.

UI lives on the main Shack tab as the *Lightning Protection* group
(width 12, order 9).

### SPE Amplifier

Reads the SPE Expert 1.5 KFA over FTDI serial at 250 ms intervals
(76-byte fixed frame, checksum + wraparound validation). Power-on is
sent over the WebSocket and performed by the `spe-remote` gateway's
DTR/RTS toggle (`spe/power_control.py`); `power_spe_on.py` is a
standalone fallback for when the service is down.

**Output-power bar — auto-ranging.** The bar's full-scale value is
picked from a ladder (5 / 10 / 25 / 50 / 100 / 250 / 500 / 1k / 1.5k
/ 2k / 5k W) — the smallest rung that still contains the current
reading. So a 3 W tune carrier fills ~60 % of a 5 W bar, a 700 W blast
fills ~70 % of a 1 k W bar, and a clean 1.5 kW key-down sits on the
1.5 k W rung. Matches the legacy `/ui` SPE Panel behaviour with a
finer low-end ladder (so low-power tuning is actually readable). The
amp's L / M / H power-level setting is still shown separately as a
tile (`PWR LVL` / colour-coded amber/red for Middle/Maximum), but
does not drive the bar scale — auto-ranging tracks the *actual*
output regardless of the amp's selected level cap.

**TUNE control + LED.** The `Tune` button starts an ATU tune cycle, and
its colour mirrors the amp's front-panel **TUNE LED** — the button stays
neutral while the LED is off and turns solid amber (with a glow, and a
`⚡ TUNE` chip in the Vue card's collapsed header) while the amp is in
TUNE mode. The LED state comes from the amp's RCU LCD stream (decoded in
the `spe-remote` gateway), not the CSV status frame, so it's live
whenever the gateway is running.

**Power meter modes — RAW / AVG / PEAK.** A pill toggle by the Output
Power bar (both dashboards) switches what the bar shows: **RAW** (the
live ~25 Hz reading), **AVG** (a ~1 s smoothed average), or **PEAK** (a
peak-hold that pins the highest reading ~2.5 s then eases back down at a
constant 600 W/s). AVG and PEAK are derived in the `spe-remote` gateway
(`p_out_avg` / `p_out_peak`); each pill appears only once the gateway is
sending that field, so an older gateway simply shows RAW. PEAK is a
*sampled* peak (25 Hz) — good for catching sustained SSB/CW crests, not
a true envelope-PEP wattmeter. The chosen mode persists in the browser
and is shared between `/ui` and `/shack`.

### FlexRadio

TCP API to the FLEX-6600 at `192.168.1.148:4992`, plus UDP discovery.
Per-slice state (frequency, mode, RX/TX, meter levels) aggregated
into `flexState` flow context and rendered into the FlexRadio panel.
`clientHandleMap` is built from the discovery message so we can label
slices with the GUI client station name.

**Transmit-state semantics** — two distinct concepts that look the same:

- `slice.tx == 1` and the derived `slice.isTx == 1` mean *"this slice is
  the TX-armed slice"* — i.e. **which** slice would transmit if you
  keyed up. It does NOT mean the radio is currently transmitting.
  (Aggregator handles split mode where both slices have `tx==1`: it
  picks the one with `active==0` as the true TX.)
- `flexState.txstate` (string) is the actual radio state — `"READY"`
  while receiving, something else (e.g. `"TRANSMIT"`) while keyed.

The new Vue `/shack` dashboard uses **`txstate`** for the live `RX`/`TX`
indicator in the FlexRadio card header. The old D1 panel mixes the two
in places but renders correctly because of the surrounding context.
**Lesson:** if you add any "is the radio transmitting right now?" logic
to a flow node or template, key it off `flexState.txstate`, not
`slice.isTx`.

### Power Control (Tasmota fleet)

5 Tasmota devices, 21 outlets total. Each outlet has its own dashboard
tile; the panel template is fully driven from MQTT `stat/<device>/POWER<n>`
state messages. Outlets default to `off` on page-load to avoid the
"stale ON" bug; a 30 s poll loop pings every outlet across every
device so the dashboard never lies for more than ~30 s.

The 16 A master switch publishes energy data every 30 s for shack-wide
consumption monitoring. The rotator outlet has a 5 min auto-off timer
with idempotent retrigger guard + 10 s cooldown to prevent reset loops.

Below the 16 A voltage/current/power/today line, both dashboards carry
a **Phase loads** graph tile (added 2026-10-19): inverter L1 / L2 / L3 = R / Y / B
load over the last ten minutes with the 5 kW per-phase off-grid limit and the
4.5 kW shedding line (Deye: 5 kW per phase, 10 kW total), live watts per phase, fed every 5 s straight from the
inverter's logger by `solar_phases_mqtt.py` (retained `shack/solar/phases`), plus
two further rows (added 2026-08-25): a **solar row** of two half-width
tiles — **Grid** (ON/OFF plus the three input phase voltages) and
**Battery** (state of charge, with charge state and power on one line)
— read directly from the Deye hybrid inverter's Solarman logger by
`solar_inverter_mqtt.py` (1-min cron → retained
`shack/solar/inverter`, and since 2026-08-25 an append-only
`~/grid_voltage.csv` — see *Grid voltage log* below; both scripts live in the private
`vu2cpl/power-management` repo since 2026-10-27) — and a **house-loads row** showing the four
house Tasmota circuits (FF Load, GF Load, Dryer Kit, Utility): relay
ON/OFF, live watts, and today's kWh. Each house tile is also the
switch — click, confirm, and it toggles the relay via
`POST /power/house-toggle`. The relays belong to Home Assistant's
load-shedding automations (battery-SOC; the grid-loss overload shedding
of Utility and Dryer Kitchen added 2026-10-19 is all off since 2026-10-25,
see `docs/load-shedding.md` in `vu2cpl/power-management`), which may override a manual
toggle on their next threshold rule.

#### Grid voltage log, stabiliser watchdog, supply-interruption history

Moved on 2026-10-27 to [`vu2cpl/power-management`](https://github.com/vu2cpl/power-management) (private), with the scripts: the 1-min `~/grid_voltage.csv` log written by
`solar_inverter_mqtt.py`, `grid_voltage_report.py`, the stabiliser watchdog `stabiliser_watch.py`, the sealed
August bypass window, and `deye_history_report.py` for the Solarman cloud history. See its `docs/grid-voltage.md`.
The Pi still runs its own copies in `~/`; the dashboard tiles above stay here.

### Solar Conditions

Polls NOAA SWPC every 15 min for SFI, K-index (8 × 3-hour planetary
Kp), A-index (planetary Ap), Scales (R/S/G), GOES X-ray flux, and
prop.kc2g.com for MUF / foF2 at home grid. Three ui-level gauges +
band-condition heatmap.

### LP-700 Power/SWR Meter

Migrated from direct USB-HID to a WebSocket client of the
[VU3ESV/LP-700-Server](https://github.com/VU3ESV/LP-700-Server)
gateway running on the same Pi. The gateway owns `/dev/hidraw*`;
Node-RED, the embedded web client, and any future Mac SwiftUI app
all subscribe to telemetry concurrently. Updates at ~25 Hz. Buttons
emit JSON command verbs (`channel_step`, `range_step`, etc.).

### Rotator

Yaesu rotator behind an Idiom Press Rotor-EZ (DCU-1) interface on FTDI
serial at 4800-8N1. Heading display + preset compass-rose buttons. Since
2026-06-06 the serial port is owned by the
[`rotator-remote`](https://github.com/vu2cpl/rotator-remote) gateway
(`rotator-remote.service`, `:8090`) — the Node-RED tab is a thin WebSocket
client, so the browser, a future Mac app, and any other client share the
rotor without serial contention. Power stays on Tasmota/MQTT. Since
2026-09-08 both dashboards show an **OVERLAP LED**: the rotor turns past
360° of travel, but DCU-1 only reports azimuth mod 360, so the gateway
derives the flag by watching the heading cross the South end stop with
direction (persisted across restarts) and broadcasts it with every state
frame.

### DXCC Tracker

> **Disabled since 2026-08-27** (operator choice): the flow tab is
> `disabled` in flows.json and the Vue card hidden via `CARDS.dxcc`.
> Nothing is deleted — flip both flags back to re-enable.

DX cluster spot monitoring with real-time alerts for new entities,
bands, and modes against Club Log worked/confirmed data. Subscribes
to four cluster sources (VU2CPL, VU2OY, KIEL, N2WQ); resolves prefix
via cty.xml; classifies against `bands[mk] === 2` confirmed criterion;
fires alerts to dashboard, MQTT, FlexRadio, and Telegram.

**Full reference:** [`DXCC.md`](DXCC.md).

### RPi Fleet Monitor

Subscribes to `rpi/<hostname>/{cpu,mem,temp,disk,uptime,ip,status}`
MQTT topics. Builds a fleet-status panel with one card per host;
alerts on CPU >90 %, Temp >75 °C, Mem >90 %, Disk >90 %. Reboot /
Shutdown buttons send `POST /reboot` or `/shutdown` to each host's
`rpi-agent.service` listening on `:7799`.

Currently monitoring 7 hosts: `noderedpi4`, `openwebrxplus`, `gpsntp`,
`meridianpi5`, `HassPi` (via HA's own MQTT automation), and the two
Zynq boards `rp-f02054` (Red Pitaya) + `web-888` (via
`monitor_redpitaya.sh` — telemetry only, no control agent).

A separate **Chrony / GPS Time Server** card on the *Shack Monitoring
tools* dashboard tab (Network Monitor group) shows live status of
`gpsntp.local` — the stratum-1 GPS-disciplined NTP server. Single
`ui_template` driven by retained MQTT topic `shack/gpsntp/chrony`
(cron-published every minute by the Pi-side
[`pi-gps-ntp-server`](https://github.com/vu2cpl/pi-gps-ntp-server)
project). Threshold-aware (orange when offset / dispersion / skew
exceeds tolerance, ref source ≠ PPS, or fix < 3D).

**Per-Pi onboarding runbook:** [`DEPLOY_PI.md`](DEPLOY_PI.md).

### Internet & Network Monitor

Pings local infrastructure (router, AP, key servers) and the broader
internet (DNS, well-known anycast hosts) at intervals; surfaces
latency + reachability on a status grid. Used to diagnose whether a
station-wide problem is local network or upstream.

### RBN Skimmer Monitor

Reverse Beacon Network monitoring — tracks how the VU2CPL signal is
being heard worldwide via skimmer reports. Calibration data fetched
from `sm7iun.se/rbnskew.csv` daily at 00:30 UTC (retry 01:30 UTC),
just after sm7iun's ~00:15 UTC recalculation.

Three skimmer feeds, each with spot counts for the last 1 h / 12 h /
24 h (CW vs FT8), last spot and frequency skew, on both dashboards and
in Home Assistant. Each call+SSID is a separate receiver and is never
merged with another: VU2OY and VU2OY-9 are two rigs with their own skew.

| Skimmer | Feed | Notes |
|---------|------|-------|
| VU2CPL-88 | `vu2cpl.ddns.net:7550` | the shack's own Meridian container on `.109`, via the router forward; login required |
| VU2OY-9 | `vu2oy.ddns.net:7550` | Ranjith VU2OY's Meridian server in Trivandrum; login required since 2026-10-14 (it was an open no-login port before). Feed prints `VU2OY-9-#`; keyed `VU2OY-9` since 2026-10-15 |

**Skimmer calibration.** sm7iun publishes each RBN skimmer's frequency
skew daily, from yesterday's RBN data: `rbnskew.csv` for the newest day,
`rbnhist.txt` for the last ten. Node-RED fetches both at 00:30 UTC (retry
01:30 UTC) and on start, keeps
the local skimmers' daily values for 30 days, and shows them in a
*Skimmer calibration* section on both dashboards. Each local SSID gets a
row with a sparkline on a shared ±3 ppm scale (dotted guides at ±1.5 ppm,
where amber turns red; values beyond ±3 pinned to the edge) and its last
value. When sm7iun has no value for a skimmer on its newest day, the tile
shows that SSID's own last value with its age ("1d old"), never another
SSID's. The idea of tracking every local skimmer's calibration over time
comes from VU2PTT's Skimmer Calibration tracker.
| VU24DX-1 | `vu24dx.ddns.net:7300` | Adersh VU24DX's Meridian server in Kozhikode (added 2026-10-07); login required. Feed prints `VU24DX-#`, but it is VU24DX's only RBN receiver, `VU24DX-1`, so it's keyed by that call |

---

## Repository Layout

```
├── flows.json                       Main Node-RED flow (canonical source)
│
├── as3935_mqtt.py                   AS3935 chip daemon — standby fallback (ESP32 bridge is primary publisher)
├── as3935_tune.py                   LC-tank TUN_CAP sweep helper
├── rpi_agent.py                     HTTP reboot/shutdown agent (→ rpi-agent.service)
├── rpi-agent.service                systemd unit for rpi_agent
├── monitor.sh                       MQTT telemetry cron (every minute)
├── (moved 2026-10-27)              Deye inverter / grid-voltage / load-monitor scripts → vu2cpl/power-management (private)
├── monitor_redpitaya.sh             Fleet telemetry variant for the Red Pitaya (Alpine/BusyBox, Zynq XADC temp)
├── flows_guard.py                   Stale-tab wipe tripwire (git pre-commit hook + 1-min cron w/ Telegram alert)
├── flows_guard_middleware.js        Server-side deploy rejection (httpAdminMiddleware in settings.js)
├── power_spe_on.py                  SPE amp FTDI DTR/RTS power-on helper
├── enable_file_context.sh           One-shot Node-RED file context store enabler
├── rebuild_pi.sh                    Automated bare-metal rebuild script (paired with REBUILD_PI.md)
├── disk-survey.sh                   Read-only audit of where a shack Mac's disk went (volume, TM snapshots, build trees, caches)
├── reclaim-disk.sh                  Frees it: gitignored build trees under ~/projects + named caches. Dry-run unless --apply
├── restic/                          Nightly restic backups of the Linux boxes (.109, macmini-server) to the NAS (DS710+, Debian + OMV), copied to .109's HDD and off-site to Google Drive
├── nas-debian/                      DS710+ front panel under Debian: status/power/eSATA LEDs + power/copy buttons (microcontroller), disk 1 bay LED (GPIO), RAID state on the LEDs, temperature-driven fan
│
├── as3935.service                   systemd unit for as3935_mqtt.py (installed but disabled; re-enable as fallback if ESP32 fails)
│
├── README.md                        This file (umbrella overview)
├── DXCC.md                          DXCC Tracker reference
├── CLAUDE.md                        Operator deep-reference: node IDs, gotchas, runtimes
├── REBUILD_PI.md                    Disaster-recovery runbook: blank SD → working shack
├── DEPLOY_PI.md                     Per-host fleet-member onboarding runbook
├── FORK_GUIDE.md                    Customisation runbook for forking to a different station
├── HANDOVER.md                      Session pickup notes
├── SHACK_CHANGELOG.md               Dated changelog of non-DXCC tab changes
└── LICENSE                          MIT
```

---

## Documentation map

| Doc | Audience | When to read |
|-----|----------|--------------|
| [README.md](README.md) | Anyone | First — what is this repo |
| [CLAUDE.md](CLAUDE.md) | Operator (and the LLM context) | Looking up a node ID, broker port, install command |
| [REBUILD_PI.md](REBUILD_PI.md) | Operator (disaster recovery) | "The shack Pi died — rebuild from blank SD card" |
| [DEPLOY_PI.md](DEPLOY_PI.md) | Operator | Onboarding a *different* Pi as a fleet member (telemetry + reboot agent only) |
| [FORK_GUIDE.md](FORK_GUIDE.md) | Different operator forking the repo | "I'm not VU2CPL but I want to run this stack at my own QTH" — per-site customisation runbook (callsign, grid, MQTT broker, hardware substitutions, `/shack` rebadging) |
| [DXCC.md](DXCC.md) | Operator | Working on the DXCC tab specifically |
| [SHACK_CHANGELOG.md](SHACK_CHANGELOG.md) | Future-self | "What did I change on day X" |
| [HANDOVER.md](HANDOVER.md) | New session pickup | "What was I in the middle of" |
| [restic/README.md](restic/README.md) | Operator | Backups of the Linux boxes: what is covered, the NAS / .109 / Google Drive copies, where the password lives, how to restore |

---

## Standard commit sequence

After deploying changes in the Node-RED editor:

```bash
ssh vu2cpl@192.168.1.169
cd ~/.node-red/projects/vu2cpl-shack
nrsave "<description>"     # alias: git add flows.json && git commit -m
git push
```

Pull on the Mac side:

```bash
cd ~/projects/vu2cpl-shack
git pull
```

For DXCC tab changes the commit additionally regenerates the tab
extract — see [DXCC.md](DXCC.md#standard-commit-sequence).

---

## License

MIT — see [LICENSE](LICENSE). Third-party code embedded in
`flows.json` (notably from
[VU3ESV/LP-700-Server](https://github.com/VU3ESV/LP-700-Server))
retains its own terms.

---

*73 de VU2CPL*
