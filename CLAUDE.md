# CLAUDE.md — VU2CPL Shack Automation
**Operator:** Manoj (VU2CPL) | MK83TE | Bengaluru, India
**Repo:** github.com/vu2cpl/vu2cpl-shack (private)
**Last updated:** June 2026

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
4. **On every flows.json commit**, extract the DXCC Tracker tab alongside it. **As of 2026-05-11 this is baked into the Pi-side `nrsave` function** (`~/.bashrc`) so the normal `nrsave "msg"` workflow handles it automatically. If you commit flows.json by any other path (`git add` directly, an editor's git plugin, etc.), run the extract yourself:
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
| UberSDR metrics | External UberSDR receiver publishing to the shack broker: `ubersdr/metrics/sessions` (session list) + `ubersdr/metrics/voice_activity/<band>` (12 bands). **Read-only** — the `UberSDR` flow tab aggregates + displays, publishes nothing back. |
| MQTT broker node ID | `f4785be9863eab08` |
| FlexRadio | `192.168.1.148:4992` (TCP API + UDP discovery) |
| SPE WS gateway | `spe-remote.service` on Pi @ `ws://192.168.1.169:8888/ws` (single FTDI-serial owner, multi-client fan-out). Repo [`vu2cpl/spe-remote`](https://github.com/vu2cpl/spe-remote). Also handles SPE power-on via DTR/RTS on the open port. No `/healthz` — liveness = `curl http://…:8888/` |
| LP-700 WS gateway | `lp700-server.service` on Pi @ `ws://192.168.1.169:8089/ws` (single HID owner, multi-client fan-out) |
| Rotator WS gateway | `rotator-remote.service` on Pi @ `ws://192.168.1.169:8090/ws` (single FTDI-serial owner, multi-client fan-out). Repo [`vu2cpl/rotator-remote`](https://github.com/vu2cpl/rotator-remote). Azimuth/serial only — rotator power stays on Tasmota/MQTT. Also serves a standalone compass web UI at `http://192.168.1.169:8090/` (independent of Node-RED, like spe-remote's `:8888/`) |
| Git function | `nrsave "message"` (bash function in `~/.bashrc` on Pi) → regen DXCC tab extract → add flows.json + extract → commit |
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

## FLOW TABS (12 total)

| Tab Label | Tab ID | Nodes | Dashboard Group |
|-----------|--------|-------|-----------------|
| SPE (WS) | `spe_ws_tab_01` | 12 | `vu2cpl_grp_spe_ws` |
| Rotator | `3d26c2c5270bdb37` | 28 | `84143f78d088f01d` |
| FlexRadio | `a0a882f85c89cffc` | 44 | `vu2cpl_grp_flex` |
| LP-700-HID ws | `18fb42443172f33c` | 21 | `vu2cpl_grp_lp700` |
| Solar | `590e889d44815afb` | 37 | `vu2cpl_grp_solar` |
| RBN Skimmer Monitor | `f9a0e3ad0e019052` | 21 | `1bcbc2eb8f2124aa` |
| RPi Fleet Monitor | `d5fec2fea3dd37f4` | 30 | `f8d1f7eb7403a442` |
| Internet and network monitor | `b05f8c028b368ae9` | 28 | `f10110e00bae2689` |
| Lightning Antenna Protector | `75e2cac8ab96f556` | 92 | `8b723cd03854ac2c` |
| All Power Strips | `b76a5310767803b4` | 48 | `vu2cpl_grp_power` |
| DXCC Tracker | `d110d176c0aad308` | 77 | `grp_dxcc_stats` |
| UberSDR | `ubersdr_tab` | 6 | `ubersdr_grp` (on Shack Monitoring tools) |

> Node counts drift as flows evolve — treat as approximate; re-count against
> `flows.json` if exact. (Re-counted live 2026-06-27.) The SPE tab is
> `spe_ws_tab_01` ("SPE (WS)"), a WebSocket client of `spe-remote` — the old
> `648eb83c2566c7b6` serial-owning tab is long gone.

### Dashboard tabs

Only two `ui_tab`s remain — the Lightning-detect and DXCC dashboard tabs were
folded into the main **VU2CPL Shack** tab (2026-05-08 and the DXCC merge), so
their old IDs (`dd11372f9c492be8`, `tab_ui_dxcc`) no longer exist.

| Name | ID | Order |
|------|----|-------|
| VU2CPL Shack | `vu2cpl_ui_tab_shack` | 1 |
| Shack Monitoring tools | `bcce4e07ac31b882` | 4 |

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

All 5 devices: `Timezone +05:30` (IST), set 2026-05-14. Required so
`ENERGY.Today` on `16Amasterswitch` rolls over at local midnight (not
00:00 UTC = 05:30 IST). Set per device via web Console
(`Timezone 5:30`) or MQTT
(`mosquitto_pub -h 192.168.1.169 -t cmnd/<device>/Timezone -m "5:30"`);
persists across reboots. Verify with empty-payload read:
`mosquitto_pub … -t cmnd/<device>/Timezone -n` → reply on
`stat/<device>/RESULT`.

### USB Serial Devices (stable /dev/serial/by-id paths)

| Device | Path | Baud |
|--------|------|------|
| SPE Expert 1.5 KFA | `usb-FTDI_FT232R_USB_UART_AI040UZR-if00-port0` | 57600-8N1 |
| SPE (alternate) | `usb-FTDI_FT232R_USB_UART_AI040V80-if00-port0` | 115200-8N1 |
| Rotor-EZ | `usb-FTDI_FT232R_USB_UART_AL05J29R-if00-port0` | 4800-8N1 — owned by `rotator-remote.service`, **not** Node-RED (since 2026-06-06) |

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
| `593f22a507b46335` | Parse Open-Meteo → Strike | Sets `flow.om_state` + emits CAPE tile / log msg to Master Dashboard. **No longer emits a strike-shaped payload as of 2026-05-27** (was a synthetic 0-km strike pre-matrix-fix; misleading cosmetically). The name "→ Strike" is now a historical artifact — node title kept for grep stability. |
| `c6d09b384716b54c` | Parse Weather → Header | 2 outputs: Header + Dashboard |
| `eee1a8b8552aa21f` | Header — Clocks + Weather | ui_template on Shack tab |
| `b2e2ed6a2bba24af` | Tasmota Antenna Switch | mqtt out |
| `9b4f3f603a7ab65f` | Tasmota Radio Switch | mqtt out |
| `0a664ba977970e17` | Parse AS3935 | 3 outputs: lightning/disturber/noise |
| `d1dca3df391cdfb8` | Stats → Dashboard | Flow state → dashboard |
| `f2092c6e0d932c7b` | HTTP → Antenna ON | Handles /lightning/ant-on |
| `f5b66018bf5eedd9` | HTTP → Radio ON | Handles /lightning/radio-on |
| `light_jsonl_append_01` | Append Lightning JSONL | Historic event store writer (`nr_lightning_events.jsonl`) |
| `light_bootstrap_inj_01` | Bootstrap Event Log (startup) | One-shot inject, `onceDelay: 2` |
| `light_bootstrap_fn_01` | Bootstrap Event Log from JSONL | Rehydrates `flow.event_log` from JSONL tail on restart |
| `as3935_cmd_mqtt_out` | AS3935 Cmd → bridge | `mqtt out` to `lightning/as3935/cmd`, QoS 0, retain false. Self-heal target wired from `as3935_replay_state` output 2 (auto-requests `republish_status` when `flow.as3935_status` is null, 5-min cooldown). |
| `as3935_last_event_mqtt_in` | AS3935 Last Event (retained) | `mqtt in` `lightning/as3935/last_event`. Published retained by bridge firmware (TODO #15) on every disturber/noise/lightning event. Flows into `as3935_format_state` which emits `{type:'as3935_last_event', ts_epoch_ms, event, distance, energy}` to Master Dashboard, seeding `as3935LastTs` so `LAST SEEN` is correct on Node-RED restart. |
| `tg_lightning_router` | Telegram Alert Router | Function consuming `msg.event_record` from `light_jsonl_append_01` output. Filters event types (allow-list: disconnect, reconnect, bypass_on, bypass_off, sensor_offline, sensor_online), rate-limits 5-per-60s per type, formats HTML message, sets http-request fields. Reads `flow.cfg_tg_token` + `flow.cfg_tg_chat_id` set by Init Defaults from systemd env. |
| `tg_lightning_http` | Telegram → sendMessage | `http request` POST to `api.telegram.org/bot<TOKEN>/sendMessage`. URL blank in node config — set via `msg.url` (per the Telegram HTTP request convention below). |
| `bypass_xition_detector` | Bypass Transition → event_record | Taps Bypass Handler output 1, filters on `payload.type === 'bypass_state'`, detects ON↔OFF transitions, emits `event_record` with type `bypass_on` / `bypass_off`. First sample after flow start suppressed (can't tell if it's a transition). Wires to `light_jsonl_append_01`. |
| `as3935_health_xition` | AS3935 Health Transition → event_record | Taps AS3935 Status (retained) mqtt-in (parallel wire alongside `as3935_format_state`). Detects offline↔ready transitions, emits `event_record` with type `sensor_offline` / `sensor_online`. First sample after flow start suppressed. Wires to `light_jsonl_append_01`. |

### DXCC Tracker (`d110d176c0aad308`)

| ID | Name | Role |
|----|------|------|
| `08dcd5378a79bb18` | ⚙️ Credentials (edit once) | API keys, tokens, paths |
| `38a6451a95a57685` | DXCC Dashboard | Main ui_template |
| `b981643f37259f89` | DXCC Prefix Lookup + Alert Classify | Core classification logic |
| `1a13cd6d9aabaa54` | Bootstrap Worked Table | Loads from file store / seed |
| `aa7434df62b95ebc` | Fetch All Modes + Parse lotw only | Club Log API fetch (LoTW-confirmed slice; replaced the older all-modes `9fd52c02a8486dce` which was deleted 2026-06-04 — see SHACK_CHANGELOG) |
| `6e60f619acad462e` | Build Club Log API Request | Builds API URL |
| `bf47f506a324b481` | Blacklist Manager | Manages blocked callsigns |
| `2286f0a512733e92` | Format Alert for Dashboard Table | Alert HTML formatting |
| `login-parse-dedup-v2` | Login + Parse + Dedup | 3 outputs: login-reply/spot/cluster_status. Login uses `cfg_cl_callsign + cfg_cl_login_ssid` = `VU2CPL-1`. Prompt-detection runs on the **last line** of the chunk (2026-05-17 fix) so CwSkimmer's concatenated banner+prompt no longer trips the <40-char safety guard. Output 0 wires to `2a20b140b97c35b0` (`Reply to Cluster (login)`, `beserver:reply`). |
| `2a20b140b97c35b0` | Reply to Cluster (login) | `tcp out` with `beserver:reply`, replies on the same `_session` for all 4 clusters. |
| `c68f81fda8c7f015` | Cluster Watchdog | Monitors cluster last-seen |

### RBN Skimmer Monitor (`f9a0e3ad0e019052`)

| ID | Name | Role |
|----|------|------|
| `df7d1786eab4d5a2` | Telnet VU2CPL :7300 | `tcp in` client to `vu2cpl.ddns.net:7300` — CwSkimmer telnet cluster port (auth-required). **`newline: ""`** (raw chunks) is mandatory: CwSkimmer's `Please enter your callsign:` has no trailing `\n`, so a `newline:"\n"` tcp-in buffers the prompt forever and login never fires. |
| `57819fd9ea5bbf11` | Telnet VU2OY :7550 | `tcp in` to VU2OY's open-access port (no auth, no login needed). `newline:"\n"` is fine here. |
| `fa367f22588d17bc` | Login Handler VU2CPL | 2 outputs. Splits incoming chunk on `\r?\n`. Trailing line matched against prompt fragments (`login:`, `callsign:`, etc.) → emit `VU2CPL-1\r\n` with `_session` preserved on output 0. Then loops over all lines, emits one msg per `DX de …` to output 1 (so the parser sees clean single-line input). Mirrors `login-parse-dedup-v2` on the DXCC tab. **Hardcoded login = `VU2CPL-1`** (no Credentials node on this tab). |
| `rbn_vu2cpl_tcp_reply` | Reply to VU2CPL (login) | `tcp out` with `beserver:reply`. Added 2026-05-17 — there was no tcp-out on this tab before because port 7550 needed no login. |
| `8c890a1e62738c18` | Login Handler VU2OY | Pure spot filter — no login code (VU2OY port 7550 doesn't ask). |
| `7d2c70d8935ef86f` | Parse DX Spot | Regex-parses single `DX de …` lines into `msg.spot`. Fed by both Login Handlers (output 1 for VU2CPL). |
| `713be21e706f5f9c` | RBN State Aggregator | Builds flow.skimmerState from spots. |
| `1edeb9703cae2fcb` | RBN Skimmer Panel | ui_template — live spot stream + per-skimmer status. |

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

### AS3935 Tuning (`fe70cfdcdfa19aa4`)

| ID | Name | Role |
|----|------|------|
| `987d699a22e8e608` | AS3935 Status | mqtt in `lightning/as3935/status` |
| `43fb3f2a0132b42b` | AS3935 Heartbeat | mqtt in `lightning/as3935/hb` |
| `60bafe91a9b39c13` | AS3935 Cmd Ack | mqtt in `lightning/as3935/cmd/ack` |
| `as3935_tuning_cache_status` | Cache /status | pass-through; `flow.set('as3935_status', payload)` |
| `as3935_tuning_cache_hb` | Cache /hb | pass-through; `flow.set('as3935_hb', payload)` |
| `as3935_tuning_cache_ack` | Cache /cmd_ack | pass-through; `flow.set('as3935_cmd_ack', payload)` |
| `223cb2ce733c5d3f` *(deleted — see note below)* | AS3935 Control Panel | **Standalone node deleted 2026-05-27 (HANDOVER #26, `38bf3fb`) — absorbed into the Lightning Master Dashboard (`557083037f168b22`) as a `<details>` collapsible. The tunables/actions described here now live there, not on the AS3935 Tuning tab.** ui_template; dispatches on msg.topic via `scope.$watch`. **v0.3.0** (2026-05-17): adds 🔋 battery row (`vbat_mv` from `/hb` + `/status`), Query Battery action button, `vbat_offset_mv` tunable. **Merged with Events panel 2026-05-17:** Events HTML (`<div id="a35ev">…`) appended after the Tunables panel; second IIFE in `<script>` handles event/last_event/counters. One `ui_template` = one dashboard card. Width 12, height 22. **Operator polish 2026-05-17:** Tune Cap button (`#a35tunebtn`) drives a live 30 s countdown via `a35.calibrate()` (label cycles `Tune Cap (Ns)`, button disabled until 0). Query Battery refresh is now truly instant — `cmd/ack` handler regex-extracts `vbat_mv=(\d+)` from the ack `cmd` string and writes to `hb.vbat_mv` so render() picks it up in the same tick instead of waiting for the next 30 s heartbeat. |
| `82f732a0dac14945` | AS3935 Cmd | mqtt out `lightning/as3935/cmd` |
| `as3935_tuning_replay_tick` | Replay every 5s | inject `repeat:5, onceDelay:1`. Fans out to both `as3935_tuning_replay_fn` (Control Panel) and `as3935_evt_replay_fn` (Events panel). |
| `as3935_tuning_replay_fn` | Replay AS3935 state (5s tick) | reads 3 caches, emits to Control Panel with original topics preserved. Worst-case page-open rehydration: 5 s. Substitute for `ui_control`-based instant-on (TODO #16) — `ui_control` is **not shipped in `node-red-dashboard 3.6.6`** (confirmed by `--force` reinstall, files genuinely absent). |

**AS3935 Events section (v0.3.0, 2026-05-17, merged 2026-05-17):** event log + counters + 5 TEST inject buttons. **Merged into the Control Panel** as of 2026-05-17 — same `ui_template` (`223cb2ce733c5d3f`), one card on the dashboard. The `as3935_evt_grp` ui_group was deleted; `as3935_evt_panel` ui_template was deleted; the 3 nodes that fed it (`as3935_evt_in`, `as3935_evt_cache_last`, `as3935_evt_replay_fn`) now wire to `223cb2ce733c5d3f`. **(Superseded 2026-05-27: this whole panel — Tunables + Events — was then absorbed into the Lightning Master Dashboard `557083037f168b22` as a `<details>` collapsible; `223cb2ce733c5d3f` no longer exists as a standalone node — HANDOVER #26, `38bf3fb`.)**

| ID | Name | Role |
|----|------|------|
| `as3935_evt_in` | AS3935 Event | mqtt in `lightning/as3935` (parallel subscriber to the one on Lightning tab; broker fans out) |
| `as3935_evt_last_in` | AS3935 Last Event (retained) | mqtt in `lightning/as3935/last_event` (parallel to `as3935_last_event_mqtt_in` on Lightning tab) |
| `as3935_evt_cache_last` | Cache /last_event | pass-through; `flow.set('as3935_evt_last', payload)` |
| `as3935_evt_replay_fn` | Replay last_event (5s tick) | fires from `as3935_tuning_replay_tick`; re-emits cached last_event to the merged Control Panel |
| `as3935_test_lightning_near` / `_far` / `_oor` | TEST inject buttons | publish synthetic `{event:"lightning", distance:5/25/63, energy:…}` to `lightning/as3935` for end-to-end test without the ESP32 |
| `as3935_test_disturber` / `as3935_test_noise` | TEST inject buttons | publish synthetic `{event:"disturber"\|"noise", …}` |
| `as3935_evt_test_out` | TEST publish → lightning/as3935 | mqtt out target of the 5 TEST injects |
| `as3935_test_comment` | (comment) | header above the test buttons |

---

## HTTP ENDPOINTS

| Method | Path | Tab | Purpose |
|--------|------|-----|---------|
| POST | `/lightning/ant-on` | Lightning | Force antenna ON; clears `manual_off`; emits `manual_on` event_record |
| POST | `/lightning/ant-off` | Lightning | Force antenna OFF; sets `manual_off=true` (sticky, file scope); emits `manual_off` event_record |
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
{type: 'as3935_last_event', event, distance, energy, ts_epoch_ms}
{type: 'cape',         cape: <J/kg>, om_state: 'cold'|'lit'|'severe'}
{type: 'clear'}
{type: 'log',          html: '...'}
// Stats: no type field, has threshold_km
```

Weather data to Header template (`eee1a8b8552aa21f`): plain `wxData` object (no type wrapper).

---

## FLOW-SPECIFIC NOTES

### Lightning Antenna Protector
- **Init Defaults** node is the single config point — edit only this node
- Open-Meteo CAPE→state mapping (2026-05-12): cold / lit / severe — see "Distance-graded disconnect" matrix below. Replaces older `km = (1 - index/100) * 200` lightning_potential synthesis (null in India)
- AS3935 MQTT topic: `lightning/as3935` (published by ESP32 bridge in `vu2cpl-as3935-bridge` since 2026-05-11), payload: `{event, distance, energy, timestamp}`
- AS3935 distance 63 = out of range → treated as 0 km (close zone → always disconnect)
- AS3935 ESP32 bridge cmd channel: `lightning/as3935/cmd` (in), `lightning/as3935/cmd/ack` (out, not retained). `set` keys: nf, wdth, srej, tun_cap, mask_dist, min_num_lightning, afe_gb (`"indoor"`/`"outdoor"`), modem_sleep. Actions: republish_status, calibrate_tun_cap, reboot, factory_reset_wifi. NVS-persisted; status republished after each successful set. Controlled from the **AS3935 Control Panel** — since 2026-05-27 a `<details>` collapsible inside the Lightning **Master Dashboard** (`557083037f168b22`), not a standalone node (HANDOVER #26, `38bf3fb`; the `AS3935 Tuning` flow tab `fe70cfdcdfa19aa4` now holds only the mqtt-in / cache / cmd plumbing)
- Weather: Parse Weather has 2 outputs — output 1 → Header (plain wxData), output 2 → Master Dashboard ({type:'weather'})

#### Dashboard ANT toggle drives manual-off (2026-06-03, second pass)

Both dashboards now have a **single bidirectional ANT toggle** in the
Lightning card — collapsed-view chip in Vue, button in D1. Click flips
the antenna state with a confirm dialog. Internally:

- ON click → `POST /lightning/ant-on` → existing handler, now also
  emits `manual_on` event_record (Telegram fires ✅ "ANTENNA ON
  (manual)"). Clears `flow.manual_off`.
- OFF click → `POST /lightning/ant-off` (NEW endpoint, symmetric to
  ant-on). Sets `flow.manual_off=true` (file-scoped, sticky), fires
  Tasmota OFF + TX inhibit, cancels Reconnect Timer, emits
  `manual_off` event_record (Telegram fires 🟣 "ANTENNA OFF
  (manual)").

End state: 2 controls only on the Lightning card — ANT toggle +
BYPASS toggle. The orphan **Manual Override** function node
(`22e5df9713499f53`, unreachable since some prior UI cleanup) was
**deleted** as part of this change. Its incoming wires from Master
Dashboard were also removed.

The `manual_off` plumbing below (Trigger Disconnect early-exit, etc.)
is now reachable via the UI. Before this change, the sticky-off
backend had no trigger path.

#### Manual disconnect = sticky-off (2026-06-03)

Clicking Manual Disconnect on the dashboard now sets a sticky
`flow.manual_off` flag (file-context-scoped so it survives Node-RED
restart) in addition to the existing `flow.antenna_off`. While
`manual_off` is true:

- **`Trigger Disconnect` early-exits** after the bypass guard with a
  red-ring "MANUAL OFF · src km — alert only" status. Skips the
  MQTT OFF re-send, skips the reconnect-timer reset, skips the TX
  inhibit re-fire (already inhibited).
- It still emits an `event_record` of type
  `auto_strike_while_manual_off` on a **new output 2** (Trigger
  Disconnect bumped from 2 → 3 outputs) wired to
  `light_jsonl_append_01`. JSONL → `tg_lightning_router` →
  Telegram: 🟣 **MANUAL HOLD** alert with distance / source / time.

`manual_off` is **set** by `HTTP → Antenna OFF` (`/lightning/ant-off`,
fired by the dashboard ANT toggle when clicked while on). It is
**cleared** by `HTTP → Antenna ON` (`/lightning/ant-on`, fired by
the dashboard ANT toggle when clicked while off), Force Reconnect,
and Execute Reconnect (which is the path Bypass-ON takes, so Bypass
auto-clears manual hold per operator's design choice). The 2026-06-03
"Dashboard ANT toggle drives manual-off" subsection above documents
the full UI wiring.

**Pre-fix bug this closes:** without `manual_off`, an operator who
pre-emptively disconnected before a storm would see their manual
DC silently overridden by the first AS3935 hit — Trigger Disconnect
ran the matrix, fired the disconnect chain, and Reconnect Timer
re-armed itself for 20 min. Antenna auto-reconnected mid-storm.
The 2026-05-26 retrigger-text differentiation masked this because
the Telegram alert *looked* different ("STORM CONTINUES") but the
timer was still being reset.

**Scope-alignment convention** (per HANDOVER #19 lesson): all
`manual_off` reads and writes use the explicit `'file'` scope.
Default memory scope `flow.get('manual_off')` returns `undefined`
on a fresh install which is treated as `false` (safe).

#### FlexRadio TX inhibit chain (2026-05-26)

Lightning disconnect now also sends a FlexRadio TX inhibit so the operator can't accidentally key into a disconnected antenna. Radio stays powered + RX-capable; only TX is blocked.

- **`TX Inhibit Setter`** (`tx_inhibit_setter_01`, function) reads `msg.cmd` from each upstream source:
  - `'DISCONNECT'` → emit `['xmit 0', 'transmit set inhibit=1']` (universal PTT release first, then inhibit future TX)
  - `'RECONNECT'` / `'BYPASS_ON'` → emit `['transmit set inhibit=0']`
  - Anything else → return null (not relevant)
  - Idempotent — re-firing same value is harmless, so DC retriggers during the 20-min reconnect window safely re-send the inhibit command.
  - **Command lineage** (discovered 2026-05-27 via spray-and-pray + `status_code` inspection): the working form is **`transmit set inhibit=N`** in the `transmit` subsystem. `interlock tx1_inhibit=N`, `radio set tx_inhibit=N`, and `interlock tx1_inhibit_value=N` all return error `0x5000002D` ("command not recognised") on FLEX-6600 firmware as of 2026-05-27. If you ever see this stop working after a SmartSDR firmware update, the spray-and-pray scaffolding is preserved in commit history at [`34c1db4`](https://github.com/vu2cpl/vu2cpl-shack/commit/34c1db4) — re-apply that, fire a TEST DISCONNECT, and grep journalctl for `status_code=0` to find the new working form.
- **`FlexRadio TX Inhibit`** (`flexradio_tx_inhibit_01`, flexradio-request) — uses the same `flexradio-radio` config node (`94d0df28ae5cccfc`) the FlexRadio tab uses. Config nodes are cross-tab; no new TCP connection.
- **Sources wired in** (each adds one new wire to its existing output): `Trigger Disconnect` (out 0, cmd:DISCONNECT) · `Execute Reconnect` (out 0, cmd:RECONNECT) · `Force Reconnect` (out 0, cmd:RECONNECT) · `HTTP → Antenna ON` (out 1, cmd:RECONNECT added to Tasmota msg) · `HTTP → Antenna OFF` (`lightning_antoff_fn_01`, out 1, cmd:DISCONNECT added to Tasmota msg) — added 2026-06-03 when the dashboard ANT toggle landed. Bypass ON path routes through `Execute Reconnect` so it picks up `cmd:RECONNECT` automatically — no separate wire from Bypass Handler needed. (`Manual Override` function node was the original 5th source but was deleted 2026-06-03; its trigger path was unreachable because nothing on the dashboard ever emitted `topic:'manual_override'`.)
- **TX inhibit and reconnect timer are decoupled** — the matrix decides DC, that fires `cmd:DISCONNECT` to the Setter, which inhibits TX. The reconnect timer expires → Execute Reconnect fires `cmd:RECONNECT` → Setter clears TX inhibit. If a new strike during the 20-min window re-fires DC, `flow.antenna_off` was already true, so `Trigger Disconnect` passes `retrigger:true` downstream. The TX Inhibit Setter still fires `inhibit=1` (idempotent) and the Telegram alert formatter (below) renders a different "STORM CONTINUES" message instead of duplicating the disconnect notification.

#### Telegram alert — retrigger differentiation (2026-05-26)

`Trigger Disconnect` now sets `msg.retrigger = (flow.antenna_off was already true)`. `Format Log` propagates it to `event_record.retrigger`. `Telegram Alert Router` (`tg_lightning_router`) branches:

- First disconnect (retrigger=false): `⚡ ANTENNA DISCONNECT` with distance, antenna/radio state, "TX inhibited", time
- Subsequent disconnect during reconnect window (retrigger=true): `⚡ STORM CONTINUES` — "Antenna already OFF; TX still inhibited. Reconnect timer reset to NN min from now." NN reads `flow.reconnect_min` live so the user sees the actual current countdown.
- Reconnect: `✅ ANTENNA RECONNECT` now also says "TX allowed again" so it's symmetric.

Stops the "five identical DISCONNECT alerts in a single storm" noise pattern.

#### Distance-graded disconnect (2026-05-12)

`Trigger Disconnect` (`d62fb0c3c40f03b7`) no longer fires unconditionally — it rejects only the `Open-Meteo` source (storm-probability signal, never directly fires DC) and lets every other source (`AS3935 (local)`, `TEST`, future Blitzortung etc.) pass through the 3×3 decision matrix. Only sources whose `source` string contains `AS3935` populate the corroboration window (`flow.recent_as3935`); test injects exercise the matrix without polluting that counter.

| OM state | AS3935 close (<10 km) | AS3935 medium (10–25 km) | AS3935 far (≥25 km) |
|----------|------------------------|---------------------------|----------------------|
| **cold**   | single hit → DC | 2 hits in 5 min → DC, else log only | log only |
| **lit**    | single hit → DC | single hit → DC (corroborated) | log only |
| **severe** | single hit → DC | single hit → DC | single hit → DC |

OM state is derived in `Parse Open-Meteo → Strike` from the 5-min poll and held for 20 min (`cfg_om_lit_window_min`):

| OM state | Condition |
|----------|-----------|
| cold   | CAPE < `cfg_om_cape_thresh` (800) OR wmo ∉ {95, 96, 99} |
| lit    | CAPE ≥ 800 AND wmo ∈ {95, 96, 99} |
| severe | CAPE ≥ `cfg_om_cape_severe_thresh` (2500) AND wmo ∈ {95, 96, 99} |

All seven thresholds live-tunable from `Init Defaults`:

```
cfg_close_km                = 10    // AS3935 close-zone radius (km)
cfg_medium_km               = 25    // AS3935 medium-zone radius (km)
cfg_med_window_min          = 5     // sliding window for strike counting
cfg_med_count               = 2     // hits needed in window for OM-cold medium DC
cfg_om_lit_window_min       = 20    // OM state persistence after each poll
cfg_om_cape_thresh          = 800   // "lit" CAPE threshold (J/kg)
cfg_om_cape_severe_thresh   = 2500  // "severe" CAPE threshold (J/kg)
cfg_sensor_offline_grace_min= 3     // AS3935 sensor-offline alert debounce (min)
```

Sensor-offline alert debounce (added 2026-05-16, `as3935_health_xition`): brief network blips (WiFi reconnect, MQTT keepalive timeout, ESP32 reboot) commonly produce offline→online flaps within 1–2 min. `cfg_sensor_offline_grace_min` is the minimum continuous offline time before a Telegram alert fires. Recovery (`sensor_online`) alert only fires if the matching offline alert was actually sent — silent flaps stay silent. Tune up (5–10 min) if real-world false-positives still slip through; tune down (1–2 min) if you want faster real-outage notification.

Sliding strike history lives in `flow.recent_as3935 = [{ts, km}, …]`. Pushed only when `msg.strike.source` contains `AS3935` (real sensor hits); TEST injects run the matrix without pushing, so they cannot manufacture corroboration. Filtered to the trailing `cfg_med_window_min`-minute window on every call. Persists across deploys only via memory (resets on Init Defaults run / Node-RED restart). Bypass switch still wins over everything (early-exit at top of Trigger Disconnect).

**Behaviour change vs pre-2026-05-12:** Open-Meteo-only "synthetic strike" disconnects (CAPE > 800 alone → DC) stop happening. Only actual AS3935 lightning events drive the chain; OM modulates the corroboration threshold per the matrix. Net effect: fewer false-positive DCs during high-CAPE-no-storm Bengaluru summer afternoons; same protection on real-storm days.

**Behaviour change vs pre-2026-05-27** (HANDOVER #25 closure): Open-Meteo also no longer emits a synthetic strike-shaped payload at all. Previously it sent a strike-shape to Parse Strike with `km = 0` on current-hour thunderstorm, `km = 10..100` on rising CAPE. Trigger Disconnect already early-rejected this (matrix-fix 2026-05-12) so no DC fired — but the strike got recorded in `nr_lightning_events.jsonl` as `type:'strike' source:'Open-Meteo' km:0`, and the event log read as "Open-Meteo: TS NOW → 0 km" which looked like "lightning directly overhead". Now the function only emits `type:'cape'` (CAPE tile) + `type:'log'` (descriptive text) to Master Dashboard; the wire to Parse Strike is removed; the function outputs count drops 2 → 1. Matrix corroboration logic is unaffected — it reads `flow.om_state` directly, which is still set on every OM poll. Log lines now read "Open-Meteo: Severe CAPE 2800 J/kg → SEVERE @ 14:00" (descriptive, no fake distance). Real strikes only come from AS3935 / TEST injects, as semantically correct.

### DXCC Tracker
- **Credentials node** (`08dcd5378a79bb18`): set `cl_apikey`, `cl_email`, `cl_password`, `cl_callsign`, `tg_token`, `tg_chat_id`, `cfg_flows_dir`
- `cfg_flows_dir` = `os.homedir() + '/.node-red/projects/vu2cpl-shack'`
- Confirmed logic: `bands[mk] >= 2` (Club Log value 2=confirmed, 1=worked only, 3=eQSL only=unconfirmed)
- Alert types: NEW_DXCC (red), NEW BAND (blue), NEW MODE (amber), NEW_BAND_UNCONF (blue dim), NEW_MODE_UNCONF (amber dim)
- Dedup window: 60 seconds per callsign+frequency
- Startup sequence: 0.5s Credentials → 2s Bootstrap → 5s cty.xml → 12s Club Log → 90s retry
- Data files (in `cfg_flows_dir`):
  - `nr_dxcc_seed.json` — worked/confirmed data, including per-entity CW/Ph/Data mode data under key `dxccModeWorked` (auto-refreshed daily; `updated` field is the last successful fetch ISO timestamp)
  - `nr_dxcc_blacklist.json` — blocked callsigns
  - (cty.xml — prefix → DXCC entity map; fetched on startup, not persisted as a file)
- Context store must be configured with `file` module in settings.js
- **Entity names from cty.xml are HTML-entity-encoded** (`Saint Kitts &amp; Nevis`, `Trinidad &amp; Tobago`, etc., per XML spec). The dashboard table renders them via innerHTML which auto-decodes — looks correct. But the Telegram formatter (`94b77826079bad57`, Format Telegram Alert Dedup 10 minute) uses Markdown mode which does NOT decode entities, so `a.entity` is run through a local `htmlDecode()` helper before insertion (added 2026-05-17, commit `1dd4587`). seedNames left encoded in memory so both consumers stay happy. If a new Telegram-bound formatter is added, mirror the `htmlDecode()` pattern.
- **Telegram alert icons map** in the formatter functions covers all five alert types: `NEW_DXCC:'🔴'`, `NEW_BAND:'🔵'`, `NEW_BAND_UNCONF:'🔵'`, `NEW_MODE:'🟡'`, `NEW_MODE_UNCONF:'🟡'`, `NEED_QSL:'🟣'`. **Convention:** the `_UNCONF` variant reuses the same emoji as its confirmed sibling — the `? BAND` / `? MODE` text label already signals unconfirmed; emoji's job is just the band/mode/DXCC dimension (added 2026-05-17, commit `4a72223`). Any new alert type with a confirmed/unconfirmed pair should follow the same pattern.
- DX Clusters: N2WQ (`cluster.n2wq.com:8300`), VU2OY (`vu2oy.ddns.net:7550`), VU2CPL (`vu2cpl.ddns.net:7300`), VE7CC (`ve7cc.net:23`) — VU2CPL moved 7550 → 7300 on 2026-05-17 (commit `4b1fabb`). **Port 7300 is CwSkimmer's telnet cluster port (auth required)** — both DXCC Tracker (`login-parse-dedup-v2`) and RBN Skimmer Monitor (`Login Handler VU2CPL`) send `VU2CPL-1\r\n` on the `Please enter your callsign:` prompt; tcp-out reply nodes use `beserver:reply` + `_session` to write back on the same socket. Old port 7550 was CwSkimmer's "raw" local-telnet (no auth, no prompt). See SHACK_CHANGELOG.md 2026-05-17 "VU2CPL skimmer — login handlers" for the full story and gotchas (notably `newline:""` on the tcp-in being mandatory because CwSkimmer's prompt has no trailing `\n`).

### Rotator
- **The Rotator tab is a WebSocket client of `rotator-remote.service`** (Pi @ `ws://localhost:8090/ws`) **since 2026-06-06** — it no longer owns the Rotor-EZ FTDI serial port. The gateway (repo [`vu2cpl/rotator-remote`](https://github.com/vu2cpl/rotator-remote)) polls the rotor and fans azimuth out to all clients; Node-RED is just one of them. This removed the old "restart Node-RED to free the serial port" friction and unblocks multi-client access (browser + future Mac app).
- **Heading control transport only — power is unchanged.** Rotator mains power stays on Tasmota `cmnd/powerstrip1/POWER2` over MQTT, with the auto-off timer on the *All Power Strips* tab. The gateway never touches power.
- **Key ws-client nodes** (Rotator tab `3d26c2c5270bdb37`): `rotator_ws_client` (websocket-client config → `ws://localhost:8090/ws`), `rotator_ws_in` → `rotator_ws_parse` ("Parse Rotator WS": caches `flow.rotator_heading` from the gateway's `{type:state,heading,…}`, replaces the old Slice heading), `rotator_ws_out` ← `3cfe1d67d0490107` ("Send Rotator → WS": translates the `AP1NNN\r` / `;` strings that `Build Rotator String` + `Click → Heading` still emit into `{type:command,action:goto|stop,heading}` JSON).
- **Unchanged:** `Build Rotator String`, `Click → Heading`, the compass `ui_svg`, all 4 HTTP endpoints (`/rotator/go|lpsp|stop|power-toggle`), and the Vue builder. They were not touched — only the transport under heading control changed.
- **Deploy ordering when rebuilding:** the ws-client flow must deploy (Node-RED restart, no serial nodes) **before** `rotator-remote` starts, or the gateway can't open the port. `rebuild_pi.sh` Stage 13b installs the gateway after the flow is in place; the manual order is git pull → restart nodered → `sudo ./install-service.sh` in `~/rotator-remote`.
- Protocol bytes (`AI1;` query, `AP1NNN\r` set with **CR**, `;` stop, `;`-framed replies) live in `rotator-remote/rotator/protocol.py`, extracted verbatim from the pre-refactor flow. The set/query terminator asymmetry is real DCU-1 — don't "normalise" it.

### All Power Strips (Rotator)
- Rotator timer node (`05f0ddeb566a90fc`): set to `5 * 60 * 1000` (5 min) for production — done 2026-05-10 (`971f4b4`)
- Timer does NOT survive Node-RED restart — acceptable for rotator use
- Rotator **power** (this outlet) is the only rotator concern still in Node-RED; **heading control moved to `rotator-remote.service`** 2026-06-06 (see the Rotator section above).

### FlexRadio
- All slice state in `flexState` flow context
- Split mode coloring (fixed 2026-05-15): both slices report `tx:1` in split mode (RX has `active:1`, actual TX has `active:0`). `Flex State Aggregator` (`de6b988cbc7182ca`) now pre-computes a per-slice `isTx` boolean — counts `tx==1 && in_use==1` slices; if more than one (split), picks the one with `active==0` as the true TX; else the single `tx==1` slice. Both `ng-class` expressions in `FlexRadio Panel` (`bf129ed26ea2ca5f`) consume `isTx` instead of the old `tx==1 && active==1` rule.
- **TX-armed vs actively transmitting (fixed 2026-05-26 during Vue migration):** `slice.isTx` only tells you *which* slice is TX-armed (the slot that would transmit if keyed). It does **not** mean the radio is currently transmitting — that's `flexState.txstate` (`"READY"` while RX, anything else while keyed). The D1 `FlexRadio Panel` happens to render correctly via context cues, but anywhere you need a clean "is the radio transmitting right now?" boolean, use **`txstate !== 'READY'`**. Vue `/shack` FlexCard header uses this; the slice table's per-row `RX`/`TX` chip is now `sliceIsActiveTx(sl) = isTransmitting && sl.isTx` so it only shows `TX` (red) when the radio is genuinely keyed AND it's the TX-armed slice.
- `clientHandleMap` built from discovery message (`gui_client_handles` + `gui_client_stations`)

### SPE Amplifier
- 250ms poll cycle, 76-byte fixed frame, checksum + wraparound validation
- **Power-on path** (as of 2026-05-15): dashboard's `ON_SPE` button sends `power_on` over the WebSocket like every other button. The `spe-remote` Python server on the Pi handles it internally — toggles DTR/RTS on the open serial port via ioctl (`spe/power_control.py` `_power_on_sync()`), which works even with the amp's CPU unpowered because the FTDI hardware lines are controlled at the host end. Earlier design had a Node-RED `exec` node calling `python3 ~/power_spe_on.py` as a side path; removed because it duplicated the same DTR sequence at a layer above. `power_spe_on.py` stays on the Pi as a standalone fallback if `spe-remote.service` is down.
- CSV logging enabled
- **Output-power bar — auto-ranging ladder** (Vue `/shack` SPECard, 2026-05-26). Replaces the older L/M/H-driven fixed `pwrMax` (500/1000/1500 W) the `ws_format_state` function still emits for D1 compat. The Vue card now ignores `state.pwrMax` and instead computes `pwrBandMax` locally by picking the smallest rung from `PWR_LADDER = [5, 10, 25, 50, 100, 250, 500, 1000, 1500, 2000, 5000]` that contains the current `state.pwr` reading. So a 3 W tune fills ~60 % of a 5 W bar; 700 W fills 70 % of a 1 k W bar; full output sits on the 1.5 k W rung. Scale label renders as `/ 5 W` … `/ 1.5k W` … `/ 5k W`. The amp's L/M/H setting is still surfaced as the `PWR LVL` tile (amber for Middle, red for Maximum) — just no longer drives the bar's full-scale value. Matches legacy `/ui` SPE Panel auto-scale but adds finer low-end rungs (5/10/25/50) so tune carriers are actually readable. Don't reintroduce the L/M/H ↔ pwrMax coupling — operator explicitly clarified that "auto-scale" means detected-power-driven ranging, not amp-cap-driven scaling.
- **Front-panel TUNE-LED indicator** (both dashboards, 2026-06-19). The amp's TUNE LED state is **not in the 76-byte CSV status frame** — it's decoded in `spe-remote` from the **RCU LCD frame** (`serial_handler.py:639`, `(payload[4] & 0x40) == 0`; CLEAR = LED on) and stamped onto every state broadcast as `tune_active` (RCU mode is auto-enabled at connect + kept alive by `_rcu_tick_loop`, so it updates live). Node-RED `ws_format_state` re-emits it as `tune: !!d.tune_active` in the flat panel payload that feeds **both** UIs (D1 `ws_panel_node` directly; Vue via `vue_spe_bridge_01` → `Object.assign`). The **Tune button's fill colour toggles** to mirror the LED (not a glow-only — the first cut left the button permanently amber and only toggled a box-shadow, which read as "no indication"). D1 `#spew-tune-btn`: neutral `gh-btn` when off → `background:var(--gh-amber)` + dark text + glow + `●` when `d.tune`; reset to neutral in the `!d.usb` wipe (heartbeat-down msgs don't carry `tune`, so the explicit reset prevents a stuck LED). Vue: `state.tune` swaps the button class `btn--blue` (off) ↔ `btn--amber` + glow + `●` (on), plus a `⚡ TUNE` chip in the collapsed header. **`tune_active` is only meaningful while RCU is running** — a CSV-only feed leaves it `false`. If the LED never lights, check the gateway is in RCU mode (it is by default).
- **Power meter — RAW / AVG / PEAK** (both dashboards, 2026-06-27). `spe-remote`'s `serial_handler.py` derives two `p_out` companions in `_consume_csv_frame`: `p_out_avg` (EMA, α=0.15, ~1 s settle at the 25 Hz TX poll) and `p_out_peak` (peak-hold — pins the highest sample 2.5 s then decays toward the live reading at a constant 600 W/s; **both reset across an op/tx transition** so a fresh TX isn't dragged by the prior idle reading). `protocol.py` carries them on `AmplifierState` (server commit `f5537ec` on `spe-remote` main). `ws_format_state` re-emits them as `pwr_avg` / `pwr_peak`, **null when the server field is absent** (not 0 — so a pre-feature gateway is distinguishable from a genuine 0 W, and the AVG/PEAK pills hide rather than show a dead button). That one flat payload feeds **both** UIs (D1 `ws_panel_node` directly; Vue via `vue_spe_bridge_01`). A pill toggle by the Output Power bar selects the source; the mode persists in `localStorage` key `speMeterMode` — **shared across `/ui` and `/shack`** (same origin), so switching mode on one dashboard switches both. D1 (`ws_panel_node`): `speRenderPwr()` picks raw/avg/peak with fallback-to-raw, caches the last payload (`speLastD`) so a pill click re-renders without a new message, and `window.speSetMode()` is the global the inline `onclick`s call. Vue: `pwrDisplay` computed is the single source every meter element reads from (bar, %, collapsed-header number); `pwrHasAvg`/`pwrHasPeak` gate the pills; build stamp → `v15`, `index.html` cache-buster → `?v=15`. **`p_out_peak` is a *sampled* peak (25 Hz poll → ~40 ms blind spots), not true envelope PEP** — said so in the field doc-comment, README, and pill tooltip. **Decay-math note:** landed from a contributed package (adersh fork) whose peak decay compounded the elapsed `decay_s` every frame — an accelerating, sample-rate-dependent fall (1500→0 in ~0.46 s) instead of the documented 600 W/s; the version here uses a per-frame `dt`-scaled decrement (verified 2.50 s for 1500→0, frame-rate independent). If that package is ever re-imported, re-apply the fix. See SHACK_CHANGELOG 2026-06-27 + spe-remote handover item 1.

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

#### Chrony / GPS Time Server card (gpsntp.local)

Single `ui_template` widget showing live status of `gpsntp.local` —
the stratum-1 GPS-disciplined NTP server. Replaces an earlier
seven-widget version on a dedicated `GPS NTP` flow tab (now an
empty orphan, scheduled for deletion).

**Placement:**
- **Flow tab** (editor view): `GPS NTP (card)` (id `4590ed80de4873b1`)
  contains just `mqtt in shack/gpsntp/chrony` (id `a278b2a1`) +
  `Chrony status card` ui_template (id `38e130c3`).
- **Dashboard tab** (browser view at `/ui`): `Shack Monitoring tools`
  (id `bcce4e07ac31b882`) → group `Network Monitor`
  (id `f10110e00bae2689`, width 6).

| Item | Detail |
|------|--------|
| Topic | `shack/gpsntp/chrony` (retained, JSON, every minute) |
| Broker | `192.168.1.169:1883` — reuses existing `mqttbroker.shack` config node, **do not duplicate** |
| Publisher | `/usr/local/bin/gpsntp-mqtt-publish.sh` on `gpsntp.local` (cron-driven; Pi-side, not in this repo) |
| Source of truth | [`vu2cpl/pi-gps-ntp-server`](https://github.com/vu2cpl/pi-gps-ntp-server) repo, `dashboard/` folder |

**Payload shape** (chrony tracking + GPS fix):

```json
{
  "host": "gpsntp", "ts": 1747032600, "ref_id": "50505300", "ref_name": "PPS",
  "stratum": 1, "system_time_offset_s": -3.5e-08, "last_offset_s": 1.52e-07,
  "rms_offset_s": 2.1e-07, "freq_ppm": 0.142, "skew_ppm": 0.009,
  "root_delay_s": 0.0, "root_dispersion_s": 1.8e-05, "leap": "Normal",
  "fix_mode": 3, "sat_used": 9, "sat_seen": 12
}
```

**Architecture note:** one `mqtt in` → one `ui_template`, no function
node in between. All formatting + threshold logic lives in the
template's `<script>`. As of 2026-05-12 the template uses **vanilla
JS DOM updates** (`getElementById` + `classList`, driven by
`scope.$watch('msg', …)`) — no AngularJS interpolation bindings —
to match the convention used by other custom widgets in this
dashboard. CSS is namespaced under `.gpsntp-card` so it doesn't
bleed into other widgets. The palette uses CSS custom properties
inside `.gpsntp-card` (GitHub-dark: `--bg #0d1117`, `--card #161b22`,
`--border #30363d`, `--green #3fb950`, `--amber #e3b341`,
`--red #f85149`). Hosting `ui_group` runs with `disp: false` (the
template carries its own title) and `width: 10`. UTC-only clock in
the footer (ham-radio convention — never `toLocaleString()`).

**Attention thresholds** (the value text renders amber `#e3b341`
when crossed; status chips also shift their LED + outline colour):
- `|system_time_offset_s|` > 1 ms
- `rms_offset_s` > 1 ms
- `root_dispersion_s` > 5 ms
- `|skew_ppm|` > 1
- `ref_name` ≠ PPS / PPS2
- `fix_mode` ≠ 3

**Updating the widget:** preferred path is in-place edit — open the
existing Chrony status card `ui_template` node, replace the format
box with `dashboard/chrony-card-template.html` from
`pi-gps-ntp-server`, Done → Deploy. Doesn't disturb group / position.
Re-importing the flow is only for replacing the broker / mqtt-in
nodes too — use Import → "Copy" (not Replace) to avoid resetting
position.

**Gotcha:** the core MQTT input node's type string is `"mqtt in"`
(with a space), not `"mqtt-in"`. Only the broker config node uses
the hyphen (`mqtt-broker`). Hand-built flows that get this wrong are
rejected on import as "unknown types".

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
node-red-dashboard           3.6.6      ← Dashboard 1 (legacy /ui)
node-red-contrib-uibuilder   7.6.2      ← Vue 3 SPA at /shack
node-red-node-serialport     2.0.3
node-red-contrib-flexradio   1.2.5
node-red-contrib-ui-svg      2.3.3
node-red-node-ping           0.3.3
node-red-configurable-ping   1.0.1
node-red-node-rbe            latest
node-red-contrib-loop        latest
node-red-contrib-ui-level    latest
```

Both `/ui` and `/shack` coexist on the same Node-RED instance with no
conflict — they share flow context and MQTT subscriptions through
common builder functions.

**Vue `/shack` card visibility (`CARDS` flags, 2026-06-04):** the root
Vue app (`uibuilder/shack/src/index.js`) has a `const CARDS = { flex:
true, lp700:true, … }` block near the top; each of the 12 cards in the
root template is gated with `v-if="CARDS.<key>"`. Flip a flag to
`false` to hide a card (nothing deleted — the component + its
builder/cmd-router nodes stay, just unrendered; flip back to restore).
This is how a forker tailors the dashboard to their hardware.
`rebuild_pi.sh` Stage 13 sets these from a "which subsystems do you
have?" Y/n round, with dependency rules (Power forced on if any of
Lightning/Rotator/Flex stay; warn if Flex dropped while Lightning
stays). For the 5 stand-alone subsystems (SPE, LP-700, Solar, DXCC,
RBN) it also sets `"disabled": true` on the flow tab so background
polling stops. Bump `window.__shackBuild` when editing card render
logic so the on-screen build stamp distinguishes "code didn't load"
from "code loaded but signal broken".

**The Vue app is host-relative — no network hardcodes.** Every `fetch()`
is a relative path (`/lightning/*`, `/dxcc/*`, `/rotator/*`) and all
data/commands use `uibuilder.onTopic`/`send`/`start` (Socket.IO to
`location.host`). So `/shack` always talks to its own Node-RED; nothing
there breaks a fork. The only VU2CPL-specific literals are cosmetic:
Stage 13 brands the TopBar callsign/sub, `index.html` `<title>`,
`manifest.json` name+description, and the `LightningCard` callsign/grid
defaults. Two `// FORK:`-marked spots can't be auto-patched (fork-specific
gear): the `NetworkCard` host list and the DXCC `clusterNames` — they must
match the forker's Node-RED stamp functions / cluster config. Keep the
`index.js` cache-buster (`?v=N` in `index.html`) in step with
`window.__shackBuild` so edits aren't served stale.

**MQTT broker is configured on the `mqtt-broker` *config* nodes, not
on the mqtt in/out nodes or in any function.** There are two config
nodes (`f4785be9863eab08` "Tasmota MQTT Broker" + `mqttbroker.shack`),
both at `192.168.1.169:1883`. The `MQTT_BROKER` const in Init Defaults
is informational only — a function node cannot reconfigure a broker
config node at runtime. When changing the broker IP (e.g. a fork),
patch the `broker` field on **both config nodes**; patching only Init
Defaults leaves all 37 mqtt nodes dialing the old IP. `rebuild_pi.sh`
collects the broker IP in its **mandatory up-front inventory** (default =
the Pi's own LAN IP) and patches both config nodes in **Stage 7 (always
runs)** — so MQTT works on a fork even if the opt-in Stage 13 customize is
skipped. (Before 2026-06-06 the broker was only set inside Stage 13's
opt-in flow; pressing Enter past it left every mqtt node dialing the
upstream `192.168.1.169` — the cause of "MQTT not working on a fresh
fork".)

**Retired packages:**

- `@gdziuba/node-red-usbhid` (LP-700 direct HID): migrated to the
  [`lp700-server`](https://github.com/VU3ESV/LP-700-Server) WebSocket
  gateway on 2026-05-09; uninstalled 2026-05-11. Its build-time `-dev`
  libs (`libudev-dev`, `librtlsdr-dev`, `libusb-1.0-0-dev`) were not
  present at uninstall time either. The runtime counterparts
  (`libudev1`, `libusb-1.0-0`, `librtlsdr0`) remain as transitive deps
  of system packages and are unrelated.
- `@flowfuse/node-red-dashboard` (Dashboard 2 POC): installed
  2026-05-24 alongside D1 to evaluate as a more-responsive successor;
  retired and uninstalled 2026-05-26 in favour of uibuilder + Vue 3.
  Lessons from the POC (D2's fixed-grid widget layout is not actually
  responsive; `ui_control` not present in v3.6.6; cross-tab wires drop
  silently) drove the decision. All `d2_*` nodes stripped from
  flows.json in the same cleanup. See SHACK_CHANGELOG `2026-05-26`.

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

Active items only. Closed/Done items moved out 2026-05-15 — full
historical context lives in `SHACK_CHANGELOG.md`, indexed by date.

| # | Item | Status |
|---|------|--------|
| 1 | **Move AS3935 antenna outdoors** — ESP32 bridge (`vu2cpl-as3935-bridge` v0.2.0) running on the bench, ready for field install. Remaining work: enclosure seal, 18650+TP4056+solar power chain, shade mount, post-install TUN_CAP retune to regain rated 40 km range. See HANDOVER #1. | Hardware |
| 6 | **Mac SwiftUI app (`~/projects/vu2cpl-shack-app/`)** — scaffold not yet started. Native macOS menu-bar app to replace the browser dashboard. Five tabs (Power, Radio, Solar, Lightning, Settings); see "MAC APP" section above for the full spec + build order. Long-term project. See HANDOVER #6. | Pending |
| 31 | ~~**Rotator → WebSocket gateway**~~ | **Done 2026-06-06** — [`vu2cpl/rotator-remote`](https://github.com/vu2cpl/rotator-remote) (Python/Tornado, `:8090`) now owns the Rotor-EZ FTDI port; the Node-RED Rotator tab is a thin ws-client. Bench-verified against the real rotor. `rebuild_pi.sh` Stage 13b installs it (opt-in). Power stays on Tasmota/MQTT. See HANDOVER #31 + SHACK_CHANGELOG 2026-06-06. |
| 34 | ~~**SPE Tune — proper button + indicator reflecting the amp's front-panel TUNE LED.**~~ | **Done 2026-06-19 — confirmed on-amp.** Node-RED + Vue only (spe-remote already decodes + broadcasts `tune_active`): `ws_format_state` emits `tune`; the Tune button's **fill colour toggles** neutral→amber to mirror the LED on both UIs (D1 `#spew-tune-btn`; Vue `btn--blue`↔`btn--amber`), Vue `⚡ TUNE` header chip. Operator ran a real TUNE cycle = button amber while LED lit, clears when done. `v14` also reworded the Vue confirm dialog ("Transmit a low-power tuning carrier within a few seconds to start tuning"). See HANDOVER #34 + SHACK_CHANGELOG 2026-06-19. |

> Canonical TODO list is in **HANDOVER.md "Open follow-ups"**. This
> table is a mirror — re-sync whenever you change one or the other.
> Closed items have full closure notes in HANDOVER (with strikethrough
> + commit hashes) and SHACK_CHANGELOG (with dated entries).

---

## GIT WORKFLOW

```bash
# Save after any Deploy:
nrsave "description"   # regen DXCC extract → add flows.json + extract → commit (function in ~/.bashrc)
git push

# Rule #4 (DXCC tab extract regen on every commit) is now baked into nrsave.
# If you need to commit flows.json manually (rare — e.g. fixing something
# nrsave doesn't cover), run the extract step yourself:
cd ~/.node-red/projects/vu2cpl-shack
python3 -c 'import json; d=json.load(open("flows.json")); v=[n for n in d if n.get("z")=="d110d176c0aad308" or n.get("id")=="d110d176c0aad308"]; json.dump(v,open("clublog_dxcc_tracker_v7.json","w"),indent=2)'
git add flows.json clublog_dxcc_tracker_v7.json
git commit -m "description"
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
- `nr_dxcc_seed.json` — worked data + per-entity CW/Ph/Data mode data (`dxccModeWorked` key); auto-refreshed daily, also written after QSOs
- `nr_dxcc_blacklist.json` — blocked callsigns
- `~/.node-red/settings.js`

Pi-side scripts already in this repo (canonical paths shown):

| Script in repo | Deployed path on Pi | Purpose |
|----------------|---------------------|---------|
| `as3935_mqtt.py` | `/home/vu2cpl/as3935_mqtt.py` | AS3935 chip daemon — **standby fallback** (ESP32 bridge in [`vu2cpl-as3935-bridge`](https://github.com/vu2cpl/vu2cpl-as3935-bridge) is the live publisher since 2026-05-11; this daemon is `disable`d but kept on disk for failover) |
| `as3935.service` | `/etc/systemd/system/as3935.service` | systemd unit for the AS3935 daemon — **disabled by default**, re-enable with `sudo systemctl enable --now as3935` if the ESP32 fails |
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
