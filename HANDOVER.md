# Session Handover — VU2CPL Shack

**Period:** 2026-05-01 → 2026-05-09
**Operator:** Manoj VU2CPL · MK83TE · Bengaluru
**Last commit at handover:** `<bumped on each cdp>`

---

## Repo state

```
~/projects/vu2cpl-shack    main   clean, in sync with origin
```

`.DS_Store` is the only untracked thing — ignore.

---

## What landed this week

| Day | Area | What changed |
|-----|------|--------------|
| 05-01 | AS3935 daemon | Revived after silent 10-day outage. Hardened `as3935_mqtt.py`: MQTT retry, LWT, 30 s heartbeat, I²C self-test, clean SIGTERM, indoor antenna mode (AFE_GB=0x12) |
| 05-01 | Open-Meteo | `lightning_potential` is null in IN. Switched to `cape` + `weather_code`, mapping rewritten (LPI in J/kg ≠ 0–100 %). Output 1 → strike chain, output 2 reserved for status |
| 05-01 | Strike labels | Source field now propagates Parse Strike → Trigger Disconnect; "Blitzortung" default removed (Blitzortung TCP not wired anyway) |
| 05-01 | Dashboard | `flow.strikes` + `flow.event_log` now persist server-side; replayed via existing 30 s `Refresh Stats` tick. Page refresh no longer wipes log/map |
| 05-06 | AS3935 IRQ | **GPIO17 in software, GPIO4 in hardware** — discovered by SRCO scan. Counter went from 0 to working immediately after IRQ_PIN=4 |
| 05-06 | LC tank | New helper `as3935_tune.py` sweeps TUN_CAP 0–15. Tuned to **TUN_CAP=10 → 499.9 kHz, -0.02 %** |
| 05-06 | Chip init | Added `CALIB_RCO` at startup, INT register flush after config writes, retained status payload includes `tun_cap`/`irq_pin`/`calib_*` |
| 05-06 | Dashboard | AS3935 panel shows live `✓ READY · NF=4 · up Nm · irq=N`. Two new MQTT-in nodes + `Format AS3935 State` + `Replay AS3935 State`. Event Log moved above Map. |
| 05-07 | Folders | Moved `~/Documents/vu2cpl website/` → `~/projects/vu2cpl-website/` and `~/vu2cpl.github.io/` → `~/projects/vu2cpl.github.io/`. CLAUDE.md path refs updated |
| 05-08 | Lightning Detect map | Ripped out entirely. Both active strike sources (Open-Meteo, AS3935) only know distance — every dot stacked on the home marker, so the map showed nothing useful. Master Dashboard ui_template trimmed by ~100 lines (HTML + CSS + Leaflet imports + `initMap()` + strikeLayer/lzCnt code in 4 message handlers). Payload `lat/lon` fields kept for future Blitzortung wiring |
| 05-08 | Nearest Strike gauge | Now persists across page refresh. `Strike → Dashboard` writes `flow.last_strike_km`; `Replay on lightning tab` emits `{type:'strikes_replay', lastKm}` on the 30 s tick; dashboard handler calls `drawGauge(lastKm)`. Boot-time `drawGauge(200)` dropped — gauge starts at "—" until first strike. **Gauge later removed entirely** when the Lightning tab was merged into the Shack tab (see below). |
| 05-08 | Lightning UI → Shack tab | Lightning Detect dashboard tab deleted. Master Dashboard moved to a new `Lightning Protection` group on Shack tab (width 12, order 9). Internal header card + weather card removed (Shack tab supplies them). Nearest Strike gauge removed. Reconnect ↺ buttons grew labels (`↺ RECONNECT`) and match switch height. |
| 05-08 | Bypass switch | New vertical `BYPASS` button between ANTENNA and RADIO. 120-min countdown, auto-expires, never survives Node-RED restart. While ON: yellow banner + amber strike alerts; Trigger Disconnect early-outs (no MQTT off, no reconnect timer). Activation force-reconnects ant + radio. New nodes: http-in `/lightning/bypass` + `Bypass Handler` function (3 outputs) + http response. `flow.bypass_active` / `flow.bypass_expires_at` reset by Init Defaults; replayed every 30 s by `Replay on lightning tab`. Verified end-to-end during a moderate-CAPE day. |
| 05-08 | Last-activity recap | Old `✔ No recent activity` filler text replaced. Boot: `⏱ Awaiting first event`. After 30 s of no new alert: muted `⏱ Last: <previous text> · Nm ago` with auto-refreshing relative time. Banner is always visible — no more lying or auto-hide. |
| 05-09 | LP-700 → WS gateway | [VU3ESV/LP-700-Server](https://github.com/VU3ESV/LP-700-Server) running as `lp700-server.service` on Pi @ `:8089`. Node-RED LP-700 tab migrated from direct `@gdziuba/node-red-usbhid` to a websocket-client of the gateway. Tab renamed `LP-700-HID ws`, trimmed 25→18 nodes. `LP State Aggregator` + `LP-700 Panel` + button router kept; `LP Dice and Slice`, `Poll Meter Values`, HID config, all polling injects + raw-buffer debug deleted. Buttons now emit JSON `{type:'command', action:'channel_step'\|'range_step'}` to ws-out. The 7 verb-test inject buttons from VU3ESV's example flow kept on canvas as testing affordances. Multi-client unlocked — Mac SwiftUI app (TODO #12) can subscribe in parallel. Post-deploy: aggregator was reading `msg.power_avg` (legacy KD4Z shape) instead of `msg.payload.power_avg` (Reshape output) → dashboard stuck at last cached values; fixed in 08c907f. |
| 05-09 | LICENSE | Added MIT LICENSE + README badge. Third-party note covers VU3ESV gateway nodes embedded in flows.json (upstream unlicensed, retained terms). |
| 05-09 | Pi-side scripts checked in | `rpi_agent.py` (HTTP reboot/shutdown agent), `monitor.sh` (MQTT telemetry cron), `rpi-agent.service` (systemd unit). Discovered during a CLAUDE.md audit that the agent doc was overstating its job — it's HTTP-only; telemetry comes from `monitor.sh` via per-minute crontab. CLAUDE.md split into separate "HTTP control agent" + "Telemetry publisher" subsections with copy/paste install commands. Backup section + new "Pi-side scripts in this repo" table added. |
| 05-09 | More Pi-side scripts in | `power_spe_on.py` (SPE Expert 1.5 KFA power-on FTDI helper) added to repo. `enable_file_context.sh` was already tracked (predated my audit). `fetch_clublog.sh` deleted from the Pi entirely — it was an old artifact whose `nr_dxcc_live.json` output is referenced by zero nodes in flows.json (verified). Live DXCC fetch happens in-flow via `Build Club Log API Request` → `Fetch All Modes + Parse` → `nr_dxcc_seed.json`. Club Log password + API key rotated since they had been pasted in plaintext. |
| 05-09 | `DEPLOY_PI.md` runbook | New top-level doc walking through full per-Pi onboarding: scp files, ownership fix, mosquitto-clients install, cron, sudoers, systemd, Node-RED httpDevices update, dashboard verify. Also covers HA Pi special case, 8-row troubleshooting table, and clean decommission flow. CLAUDE.md cross-references it. Use this when finally bringing the 2 remaining Pis online (HANDOVER follow-up #4). |
| 05-09 | Pi GPS NTP server | New standalone repo [vu2cpl/pi-gps-ntp-server](https://github.com/vu2cpl/pi-gps-ntp-server). Project pivoted from the originally-planned ESP32 firmware build (rationale: chrony + gpsd + kernel PPS on a Pi gives more accurate client-visible time, with orders of magnitude less custom code, than ESP32 firmware). Pi 3B repurposed as `gpsntp.local` @ 192.168.1.158. Taps the U3S's QLG1 GPS via the unused **6-way** header (2.2 kΩ + 3.3 kΩ voltage dividers — QLG1 outputs 5 V, Pi GPIO is 3.3 V only); U3S still has its own QLG1 connection on the 4-way and is electrically undisturbed. Stack: Pi OS Lite 64-bit Trixie, `gpsd 3.25` (`-n` flag), kernel PPS via `dtoverlay=pps-gpio,gpiopin=18` → `/dev/pps0`, chrony with `refclock PPS /dev/pps0 lock NMEA refid PPS` + `allow 192.168.1.0/24` + `allow fd00::/8` (IPv6 ULA). Headline numbers at first lock: stratum 1, PPS error ±152 ns, system clock 35 ns slow of GPS, skew 0.009 ppm, root dispersion 18 µs. Mac disciplined via `sudo systemsetup -setnetworktimeserver gpsntp.local`; `timed` keeps it within 1–4 ms over LAN. Repo carries MIT LICENSE + README + BUILD.md (stage-by-stage procedure with per-stage verification + troubleshooting) + HANDOVER.md (context, decisions, ops checks). Local dir `~/projects/Pi GPS NTP Server/` (renamed from `ESP32 GPS NTP/`). |
| 05-09 | gpsntp on RPi Fleet | First Pi onboarded via the brand-new `DEPLOY_PI.md` runbook (above). `rpi_agent.py` + `monitor.sh` + `rpi-agent.service` deployed; sudoers `vu2cpl ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown` added; `mosquitto-clients` installed; cron publishes 7 MQTT topics per minute (`cpu/mem/temp/disk/uptime/ip/status` under `rpi/gpsntp/`) to broker @ 192.168.1.169. Smoke test caught all 7 messages cleanly with `mosquitto_sub -C 7` (DEPLOY_PI.md updated implicitly: `monitor.sh` publishes without `-r`, so sub must subscribe before pub). `rpi-agent.service` active on :7799, HTTP 404 probe verified. Node-RED `httpDevices` map (function `a0695975fec84e2c`) still needs the `'gpsntp':'http://gpsntp.local:7799'` row — flagged as follow-up #9. |
| 05-10 | Lightning tier-1 cleanup | Audit pass on Lightning Antenna Protector tab dropped 2 dead nodes (`Save Reconnect`, `UI Stats`), 2 dead wires (Parse Weather → Master Dashboard, AS3935-within-threshold → Send Radio Command), and 5 dead `flow.set` lines (`map_count`, `connectCount`, `wssStatus`). 80 → 78 nodes. Operator also reduced Parse Weather output count 2 → 1 (cleaner than the wire-only fix). |
| 05-10 | Lightning tier-2 cleanup | Two passthrough/indirection nodes deleted: `Check Threshold` (computed `msg.shouldDisconnect` and `msg.thresholdKm` — neither field read by any downstream node) and `Refresh Stats` (1-line `return msg` fan-out). Haversine now wires directly to `Within threshold?`; `Stats refresh every 30s` inject fans out to its 5 destinations directly. 78 → 76 nodes. |
| 05-10 | Lightning tier-3 cleanup | Renamed `Replay on lightning tab` → `Replay Bypass State` (post-Shack-tab the old name was misleading). `Init Defaults` `node.warn` line deleted (status badge was already showing the same info). `Strike → Dashboard` and `AS3935 → Dashboard` merged into a single function detecting AS3935 by `msg.strike.source`. AS3935 Threshold Check now feeds the unified function directly (before the threshold switch) so distant AS3935 strikes banner-render with amber/green colour, matching the OM path. `Within threshold?` switch (OM path) trimmed from 2 rules/outputs to 1 — its `else` branch was always empty. 76 → 75 nodes. Audit complete: 80 → 75 over three tiers. |
| 05-10 | Docs reorg | `README.md` was the DXCC reference doc with a station footer — predated every other subsystem write-up. Split into umbrella `README.md` (hardware + 11-subsystem summary + repo layout + doc map, ~290 lines) plus dedicated `DXCC.md` (previous content verbatim, retitled). `DXCC_Tracker_README.pdf` now regenerates from `DXCC.md`. CLAUDE.md rule #3 + the SHACK_CHANGELOG header updated to reference the new pairing. Future per-subsystem docs (e.g. `LIGHTNING.md`) can now slot in cleanly without bloating the GitHub front page. |
| 05-10 | `REBUILD_PI.md` + `as3935.service` | Disaster-recovery gap closed. `as3935.service` systemd unit (previously only on the Pi, not in the repo) added alongside the existing `rpi-agent.service`. New top-level `REBUILD_PI.md` runbook walks through full from-scratch rebuild of the main shack Pi in 12 steps (OS install → mosquitto → Node-RED + palette → Projects feature → GitHub SSH + clone → file context store → Pi-side scripts + systemd + sudoers + cron → hardware/udev → lp700-server → DXCC creds → Tasmota broker check → 12-point verification + 6-row failure-modes table). README + CLAUDE.md cross-link it. README's doc-map now distinguishes `REBUILD_PI.md` (this Pi, full install) from `DEPLOY_PI.md` (a *different* Pi as a fleet member). |
| 05-10 | DXCC: VU2OY IP→DNS | Two stale doc references (DXCC.md cluster table + CLAUDE.md DXCC bullet) still cited the VU2OY cluster by IP `103.153.92.118`. flows.json was already exclusively using `vu2oy.ddns.net`. Both docs updated; DXCC PDF regenerated. |
| 05-10 | DXCC: N2WQ disconnect cycle fix | N2WQ was kicking us in a tight loop. Two interlocking causes. (1) Login regex `includes('login:')` matched the welcome banner's `Last login:` line, triggering a duplicate `VU2CPL\r\n` send → AR-Cluster's no-duplicates policy kicked us. Fixed by tightening to `length < 40 && endsWith('login:'/'callsign:'/etc.)`. (2) Even after the regex fix, kicks continued because **another LAN device was also logged in as VU2CPL** (never identified — not Mac, not Pi; possibly iOS app, logging program, or forgotten `nc` session). Sidestepped via packet-radio SSID: Credentials node now has `cl_login_ssid: '-1'`; `Login + Parse + Dedup` sends `(callsign + ssid)`. Node-RED now logs in as `VU2CPL-1`, coexists with the unknown `VU2CPL` ghost. Verified `VU2CPL-1` accepted by N2WQ-2 via manual `nc` test pre-deploy. |
| 05-10 | DXCC: secrets → systemd Environment= | While Credentials node was being touched, API key, password, Telegram token moved out of flow.func and into `/etc/systemd/system/nodered.service.d/secrets.conf` (chmod 600, root-owned). Node reads each via `env.get('VAR')` with pre-flight validation that fires `node.error` + red status badge if any var is missing. Motivation: not repo exposure (private) — rotation friction. Now: edit secrets.conf + `systemctl restart nodered`. No commit, no Deploy. `cl_email`/`cl_callsign`/`cl_login_ssid`/`tg_chat_id` stay inline (not secrets). |

---

## Current system state

| Subsystem | State |
|-----------|-------|
| AS3935 chip + I²C + IRQ wire to GPIO4 | ✅ Verified working (209 noise events caught during 05-01 storm at NF=0; TRCO+SRCO both calibrated OK) |
| AS3935 daemon (`as3935.service`) | ✅ Running with NF=4 production setting, indoor antenna mode |
| Open-Meteo CAPE polling (every 5 min) | ✅ Auto-fires disconnect when CAPE ≥ 800 J/kg or `weather_code ∈ {95,96,99}` |
| Antenna + radio auto-disconnect chain | ✅ Verified end-to-end during 05-01 storm |
| Dashboard refresh persistence (log + map + AS3935) | ✅ All three replay within 30 s of page load |
| Master Dashboard handlers | `as3935_ready`, `as3935_hb`, `as3935_status`, `bypass_state`, `log`, `strike` (incl. `as3935`) all present |
| Lightning Protection card | Lives at bottom of Shack tab (group `vu2cpl_grp_lightning`, width 12, order 9). Lightning detect tab deleted. |
| Bypass switch | Off on every Node-RED launch (Init Defaults). Auto-expires after 120 min. State persists across page refresh via 30 s replay. Verified TD bypass early-out for both Open-Meteo and AS3935 strike paths. |
| LP-700 telemetry | ✅ Via `lp700-server.service` (port 8089) → Node-RED ws-client. ~25 Hz updates. Multi-client capable. `@gdziuba/node-red-usbhid` still installed but unused; uninstall after 1 week of stable WS operation. |
| HA Pi monitoring | ✅ Implemented via HA-side automation (no Node-RED changes — `mqtt.publish` to `rpi/HassPi/*` every 30 s) |
| Pi GPS NTP server (`gpsntp.local`) | ✅ Stratum 1, PPS error ±152 ns, system clock 35 ns slow of GPS truth. Independent repo (`pi-gps-ntp-server`). Tapped off the U3S's QLG1 via the 6-way header with 5 V → 3 V dividers; U3S unaffected. Mac configured to use it as primary NTP source via `systemsetup -setnetworktimeserver gpsntp.local`. |
| gpsntp on RPi Fleet Monitor | ⚠ Pi side ready (`rpi-agent.service` active, MQTT telemetry publishing, HTTP probe 404 OK). Node-RED `httpDevices` map needs an entry for `gpsntp` to surface Reboot/Shutdown buttons — see follow-up #9. |

---

## Open follow-ups

| # | Item | Notes |
|---|------|-------|
| 1 | Move AS3935 antenna **outdoors** | Hardware. Selective 500 kHz LC tank means indoors range is ~few km only. Outdoors regains the rated 40 km. Re-run `as3935_tune.py` after relocating — stray capacitance changes |
| 2 | AS3935 systemd unit hardening | Add `After=network-online.target mosquitto.service` + `Wants=network-online.target` + `Restart=on-failure` to `/etc/systemd/system/as3935.service.d/override.conf`. Belt-and-braces with the script's own retry loop |
| 3 | Open-Meteo dashboard placeholder | Optional follow-up — the OPEN-METEO MONITOR badge still shows "Waiting for data..." between strikes. Same pattern as AS3935 fix would apply (output 2 wire + `om_status` handler). Currently low-priority — strike events already update it transiently |
| 4 | Format Log cosmetic | `msg.distance != null` instead of truthy check — currently `0 km` doesn't render the `\| N km` segment |
| 5 | Rotator timer 60s → 5min | Per CLAUDE.md TODO #3 — change `60 * 1000` to `5 * 60 * 1000` in node `05f0ddeb566a90fc` for production |
| 6 | Mac SwiftUI app scaffold | Per CLAUDE.md TODO #12 — not started. Path now `~/projects/vu2cpl-shack-app/` (was `~/Documents/...`) |
| 7 | Blitzortung real-time integration | Catches strikes Open-Meteo's 13 km grid resolution misses. Parser Cases 2/3 already in place (binary/string TCP), source label hardcoded `'Blitzortung'`. Just need a TCP-in node feeding Parse Strike |
| 8 | DXCC backlog (pending #6–11 in CLAUDE.md) | Filter persistence, separate CW/Ph/Data fetches, non-project-folder path support, README+PDF, Club Log API ban verification, daily 02:00 inject wiring |
| 9 | Add `gpsntp` to RPi Fleet `httpDevices` | One-line add to function `a0695975fec84e2c` on Node-RED Master Dashboard (`'gpsntp':'http://gpsntp.local:7799'`). Then `nrsave "RPi Fleet: add gpsntp to httpDevices"` + push. After deploy, `gpsntp` appears in Shack tab fleet panel within 60 s with live cpu/temp/mem/disk and working Reboot/Shutdown |
| 10 | Watch `gpsntp` through a U3S TX session | When U3S keys up, the QLG1 sits next to the transmitter and may RFI-desensitize. If `chronyc tracking` on `gpsntp` shows fix-loss during transmissions over the next week or so, fall back to a dedicated NEO-M8N + antenna for the Pi (already documented in `pi-gps-ntp-server/HANDOVER.md`) |
| 11 | Optional: chrony metrics on Shack dashboard | `chronyc -c tracking` returns CSV trivially publishable to MQTT (e.g. `rpi/gpsntp/chrony/{stratum,offset,ppm,...}`). New Node-RED card on Shack tab could surface stratum + last-offset for at-a-glance NTP health. Low priority |
| 12 | Install `log2ram` on `gpsntp` | Reduce SD card wear once it's been running for many months. Procedure in `pi-gps-ntp-server/BUILD.md` "Optional" section |

---

## Key files & IDs to know

```
flows.json                        — main flow file (Pi: ~/.node-red/projects/vu2cpl-shack/)
clublog_dxcc_tracker_v7.json      — DXCC tab extract (auto-regenerated per CLAUDE.md rule #4)
as3935_mqtt.py                    — chip daemon (Pi: /home/vu2cpl/, source-of-truth in repo root)
as3935_tune.py                    — tuning helper (run with service stopped)
SHACK_CHANGELOG.md / .pdf         — must stay in sync (regen PDF on every changelog edit)
nr_dxcc_seed.json                 — auto-updated by Club Log fetch; commit when changed
HANDOVER.md                       — this file
```

Critical Node-RED IDs (per CLAUDE.md):

- `75e2cac8ab96f556` Lightning Antenna Protector tab
- `557083037f168b22` Master Dashboard
- `26ddff0cbbfe5fc1` Parse Strike (only Case 1 fires — OM + test injects; Cases 2/3 dead)
- `d62fb0c3c40f03b7` Trigger Disconnect
- `593f22a507b46335` Parse Open-Meteo → Strike (CAPE-based)
- `61dca3d98a0e4c28` Refresh Stats — fan-out hub for all 30 s replays
- `f4785be9863eab08` MQTT broker config (192.168.1.169:1883, no auth)

---

## Workflow reminders

- **`cdp`** = Commit, Document (changelog + regen PDF), Push. Updates DXCC extract too if `flows.json` changed.
- **Mac → Pi** for script changes: edit on Mac, `git push`; on Pi: `git pull` then `sudo cp <file> /home/vu2cpl/<file>; sudo systemctl restart <svc>`.
- **Pi → Mac** for flow changes: `nrsave "<msg>"` on Pi; `git push`; on Mac: `git pull`.
- **PDF regen:** `npx --yes md-to-pdf SHACK_CHANGELOG.md` (no pandoc on this Mac).
- **AS3935 systemd unit needs** `Environment=PYTHONUNBUFFERED=1` in override or prints don't reach journalctl.

---

## Known weirdness

- `~/Documents` on this Mac is **local**, not iCloud-synced. Only `~/Desktop` symlinks to iCloud Drive. The 05-07 folder consolidation was for organizational tidiness only.
- `/home/vu2cpl/as3935_mqtt.py` had become **owned by root** during earlier sudo edits — `cp` without sudo silently no-op'd. Always check ownership after first deploy. Fix: `sudo cp + sudo chown vu2cpl:vu2cpl`.
- AS3935 with NF=0 fires a noise burst at startup (~209 events in 30 s) then the chip's auto-noise-track suppresses further until conditions actually change. NF=4 is the production default; NF=0 only for diagnostics.

---

## Recent commit log (for context)

```
a5a358f As3935 banner behaviour change when strike within38km
2779b04 Lightning: tier-3 cleanup — rename, demote warn, merge dashboard handlers
2cacc7a SHACK_CHANGELOG + HANDOVER: 2026-05-10 — Lightning tier-2 cleanup
6578c79 Lightning: tier-2 cleanup — drop Check Threshold + Refresh Stats passthroughs
de7c323 SHACK_CHANGELOG + HANDOVER: 2026-05-10 — Lightning tier-1 cleanup
f8ee18c Lightning: tier-1 cleanup — drop dead nodes, wires, vars
30d540e DXCC seed refresh
4791c2f some minor cleanup of unused nodes and deleted ols spe serial flow
e9c7d8e SHACK_CHANGELOG + HANDOVER: 2026-05-09 — Pi GPS NTP server build + gpsntp on RPi Fleet
0c1546d Add DEPLOY_PI.md — full per-Pi onboarding runbook
964cb04 Pi-side scripts: power_spe_on.py in, fetch_clublog.sh retired
8636ff4 Pi-side scripts: check in rpi_agent.py + monitor.sh + rpi-agent.service
9bb9631 Add MIT LICENSE + README badge
bb7415b SHACK_CHANGELOG: 2026-05-09 footnote — LP State Aggregator payload-shape fix
08c907f LP-700: fix LP State Aggregator to read msg.payload (new Reshape shape)
28e8426 SHACK_CHANGELOG + HANDOVER + CLAUDE.md: 2026-05-09 — LP-700 → WebSocket gateway
c449c49 LP-700: switch from direct HID to lp700-server WebSocket gateway
b3261ba SHACK_CHANGELOG + HANDOVER: 2026-05-08 — Lightning UI on Shack tab + bypass + last-activity recap
6a03506 Lightning: integrate to Shack tab + bypass + last-activity recap
6ac6fef DXCC extract refresh
0021bcd DXCC extract refresh
167133e Lightning: integrate to Shack tab + bypass switch (WIP — bypass not suppressing disconnect)
45bd8dd SHACK_CHANGELOG + HANDOVER: 2026-05-08 — Lightning map ripped out, gauge persists across refreshes
bf1b941 Lightning: rip out leaflet map; persist nearest-strike gauge across refreshes
46a96e8 Add HANDOVER.md — session pickup notes for 05-01 to 05-07
497ccf3 CLAUDE.md: consolidate vu2cpl repos under ~/projects/
08647ce Dashboard: AS3935 panel shows live ready/heartbeat state; Event Log moved above Map
c2c2375 SHACK_CHANGELOG: 2026-05-06 — AS3935 dashboard liveness panel
08b8511 SHACK_CHANGELOG: 2026-05-06 — AS3935 GPIO4 fix, LC tank tuning, CALIB_RCO
996c211 AS3935: re-publish status after calibration so calib_trco/srco aren't null
26c4cd3 AS3935: add CALIB_RCO at startup + INT flush + calib result in status
e20385f AS3935: apply TUN_CAP=10 (tuned to 499.9 kHz, -0.02% err); publish tun_cap+irq_pin in status
c764bda AS3935: IRQ pin is GPIO4, not GPIO17 (verified by SRCO scan)
97fbc4a AS3935: add LC tank tuning helper (TUN_CAP sweep 0..15)
acad3c5 SHACK_CHANGELOG: 2026-05-01 — AS3935 revival, Open-Meteo CAPE, source label, dashboard refresh persistence
2d69530 Lightning: persist strikes + log to flow context, replay on 30s tick
114d8a4 Lightning: propagate source through Parse Strike (Open-Meteo label fix)
b92bfb9 Open-Meteo: switch from null lightning_potential to CAPE + weather_code
```

---

*73 de VU2CPL*
