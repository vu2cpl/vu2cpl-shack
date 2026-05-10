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
  lightning sensor, RPi telemetry
- **Direct TCP/UDP** — FlexRadio (4992), DX clusters
- **Serial** — SPE amplifier, Rotor-EZ
- **WebSocket** — LP-700 power/SWR meter (via the
  [`lp700-server`](https://github.com/VU3ESV/LP-700-Server) gateway)
- **HTTP** — Open-Meteo, NOAA SWPC, Club Log, RPi fleet agent

The dashboard runs at `http://192.168.1.169:1880/ui` and is dark-themed
(base `#097479`, bg `#111111`).

---

## Hardware

| Item | Detail |
|------|--------|
| Radio | FlexRadio FLEX-6600, RGO One, Icom IC-705 |
| Amplifier | SPE Expert 1.5 KFA |
| Antennas | Hex beam, 160 m inverted-L, 6 m LFA Yagi, Beverage / N6RK / K9AY receive |
| Power | 21 Tasmota-controlled outlets across 5 devices |
| Power meter | Telepost LP-700 (USB HID, owned by `lp700-server` on the Pi) |
| Rotator | Idiom Press Rotor-EZ |
| Lightning | AS3935 sensor (I²C + IRQ on GPIO4) + Open-Meteo CAPE polling |
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
- **AS3935 chip** sensor on I²C — local ~40 km range (currently reduced
  to a few km because the antenna is indoors; outdoor relocation pending).

A vertical **BYPASS** switch on the dashboard suspends auto-disconnect
for 120 minutes (force-reconnects ant + radio on activation, never
survives a Node-RED restart). The alert banner always shows current
state with a muted "Last: …" recap after 30 s of silence. Reconnect
fires automatically after a configurable clear period (default 20 min)
once the storm passes.

UI lives on the main Shack tab as the *Lightning Protection* group
(width 12, order 9).

### SPE Amplifier

Reads the SPE Expert 1.5 KFA over FTDI serial at 250 ms intervals
(76-byte fixed frame, checksum + wraparound validation). Power-on
requires a one-shot DTR/RTS toggle from `power_spe_on.py`. Output-power
bar auto-scales between 500 W / 1000 W / 1500 W full scale based on
the amp's selected level (L / M / H).

### FlexRadio

TCP API to the FLEX-6600 at `192.168.1.148:4992`, plus UDP discovery.
Per-slice state (frequency, mode, RX/TX, meter levels) aggregated
into `flowState` flow context and rendered into the FlexRadio panel.
`clientHandleMap` is built from the discovery message so we can label
slices with the GUI client station name.

### Power Control (Tasmota fleet)

5 Tasmota devices, 21 outlets total. Each outlet has its own dashboard
tile; the panel template is fully driven from MQTT `stat/<device>/POWER<n>`
state messages. Outlets default to `off` on page-load to avoid the
"stale ON" bug; a 30 s poll loop pings every outlet across every
device so the dashboard never lies for more than ~30 s.

The 16 A master switch publishes energy data every 30 s for shack-wide
consumption monitoring. The rotator outlet has a 60 s auto-off timer
with idempotent retrigger guard + 10 s cooldown to prevent reset loops.

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

### Rotor

Idiom Press Rotor-EZ on FTDI serial at 4800-8N1. Heading display +
preset compass-rose buttons.

### DXCC Tracker

DX cluster spot monitoring with real-time alerts for new entities,
bands, and modes against Club Log worked/confirmed data. Subscribes
to four cluster sources (VU2CPL, VU2OY, VE7CC, N2WQ); resolves prefix
via cty.xml; classifies against `bands[mk] === 2` confirmed criterion;
fires alerts to dashboard, MQTT, FlexRadio, and Telegram.

**Full reference:** [`DXCC.md`](DXCC.md) /
[`DXCC_Tracker_README.pdf`](DXCC_Tracker_README.pdf).

### RPi Fleet Monitor

Subscribes to `rpi/<hostname>/{cpu,mem,temp,disk,uptime,ip,status}`
MQTT topics. Builds a fleet-status panel with one card per host;
alerts on CPU >90 %, Temp >75 °C, Mem >90 %, Disk >90 %. Reboot /
Shutdown buttons send `POST /reboot` or `/shutdown` to each host's
`rpi-agent.service` listening on `:7799`.

Currently monitoring `noderedpi4`, `openwebrxplus`, `gpsntp`. Two more
Pis + the Home Assistant Pi pending onboarding.

**Per-Pi onboarding runbook:** [`DEPLOY_PI.md`](DEPLOY_PI.md).

### Internet & Network Monitor

Pings local infrastructure (router, AP, key servers) and the broader
internet (DNS, well-known anycast hosts) at intervals; surfaces
latency + reachability on a status grid. Used to diagnose whether a
station-wide problem is local network or upstream.

### RBN Skimmer Monitor

Reverse Beacon Network monitoring — tracks how the VU2CPL signal is
being heard worldwide via skimmer reports. Calibration data fetched
from `sm7iun.se/rbnskew.csv` every 6 h.

---

## Repository Layout

```
├── flows.json                       Main Node-RED flow (canonical source)
├── clublog_dxcc_tracker_v7.json     DXCC tab extract (auto-regen on commit)
│
├── as3935_mqtt.py                   AS3935 chip daemon (→ /home/vu2cpl/, as3935.service)
├── as3935_tune.py                   LC-tank TUN_CAP sweep helper
├── rpi_agent.py                     HTTP reboot/shutdown agent (→ rpi-agent.service)
├── rpi-agent.service                systemd unit for rpi_agent
├── monitor.sh                       MQTT telemetry cron (every minute)
├── power_spe_on.py                  SPE amp FTDI DTR/RTS power-on helper
├── enable_file_context.sh           One-shot Node-RED file context store enabler
│
├── as3935.service                   systemd unit for as3935_mqtt.py
│
├── README.md                        This file (umbrella overview)
├── DXCC.md                          DXCC Tracker reference
├── DXCC_Tracker_README.pdf          DXCC reference (rendered PDF)
├── CLAUDE.md                        Operator deep-reference: node IDs, gotchas, runtimes
├── REBUILD_PI.md                    Disaster-recovery runbook: blank SD → working shack
├── DEPLOY_PI.md                     Per-host fleet-member onboarding runbook
├── HANDOVER.md                      Session pickup notes
├── SHACK_CHANGELOG.md               Dated changelog of non-DXCC tab changes
├── SHACK_CHANGELOG.pdf              Changelog rendered PDF (always in sync with .md)
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
| [DXCC.md](DXCC.md) / [PDF](DXCC_Tracker_README.pdf) | Operator | Working on the DXCC tab specifically |
| [SHACK_CHANGELOG.md](SHACK_CHANGELOG.md) / [PDF](SHACK_CHANGELOG.pdf) | Future-self | "What did I change on day X" |
| [HANDOVER.md](HANDOVER.md) | New session pickup | "What was I in the middle of" |

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
