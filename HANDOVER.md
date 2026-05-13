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
| 05-10 | DXCC: Bootstrap resilience (corrected) | The post-secrets redeploy paused the tracker. Initial diagnosis identified two issues: (1) `Load Club Log on startup` + `Retry Club Log (90s)` had `once: false` ignoring their `onceDelay`, so neither fired on deploy; and (2) `dxccReady` was only set by successful Club Log fetch, leaving cached-data-only operation impossible. Fix #2 was correct: `Bootstrap Worked Table` now flips `dxccReady=true` in all three success branches. Fix #1 was **wrong and reverted**: those injects are deliberately `once: false` as an **anti-ban measure** — Club Log had previously rate-limited the API key, and the design is 1 API call/day via 02:00 cron only. The Bootstrap fix alone is sufficient (tracker works from cached `nr_dxcc_seed.json` with zero API calls on restart). Lesson: CLAUDE.md TODO #10 ("Club Log API ban status") was the trail that should have prevented the misdiagnosis. |
| 05-10 | DXCC: real regression — spot field-name mismatch | After all the above, alerts STILL weren't firing despite all 4 clusters green and spots flowing. Tracked down to a long-standing field-name mismatch between `Login + Parse + Dedup` (emitting `spot.dxCall`, no `spot.band`) and `DXCC Prefix Lookup + Alert Classify` (reading `spot.call` and `spot.band`). The lookup hit `if (!band) return null` on every real spot and returned silently — empty node status, no alerts. TEST inject buttons set `call`/`band` directly in their payloads so manual tests worked, masking the bug. Fix: added `getBand(khz)` helper to `Login + Parse + Dedup` and emit `call` (alongside `dxCall` for backwards compat) and `band` in the spot object. Diagnosis lesson: when a downstream node shows empty status while upstream is active, suspect a field-name mismatch before chasing flags/state. |
| 05-10 | Chrony / GPS Time Server card | New dashboard for `gpsntp.local` (the stratum-1 GPS-disciplined NTP server installed 2026-05-09). `743a0d8` pushed a transitional 7-widget version on a dedicated `GPS NTP` flow tab; `286348e` migrated to the target single-`ui_template` design from [`pi-gps-ntp-server`](https://github.com/vu2cpl/pi-gps-ntp-server) `dashboard/`. Final placement: flow tab `GPS NTP (card)` (id `4590ed80de4873b1`) with just `mqtt in shack/gpsntp/chrony` + `Chrony status card` ui_template (id `38e130c3`); dashboard tab `Shack Monitoring tools` → group `Network Monitor` (width 6). Topic retained JSON, cron-published once/min by `/usr/local/bin/gpsntp-mqtt-publish.sh` (Pi-side, not in this repo). Threshold-aware (orange when offset/dispersion/skew exceeds tolerance, ref source ≠ PPS, fix < 3D). The empty `GPS NTP` flow tab (`4cac0c07`) was deleted afterwards. |
| 05-10 | `rebuild_pi.sh` automation | New 619-line bash script automating Stages 2–13 of REBUILD_PI.md. Stage-based, idempotent, resumable via `/tmp/rebuild_pi.state`, fail-fast with `set -euo pipefail`. Two unavoidable interactive pauses: Stage 6 (paste new SSH key into GitHub) and Stage 12 (`read -s` Club Log + Telegram secrets, written to systemd drop-in). Built-in 10-point verification at Stage 13. Wall-clock ~30 min vs ~90 min manual. REBUILD_PI.md updated to point at the script as the faster path; runbook stays as manual fallback + source-of-truth for what each stage does. Both must stay in sync (script banners reference runbook section numbers). |

---

## Current system state

| Subsystem | State |
|-----------|-------|
| AS3935 chip + I²C + IRQ wire to GPIO4 | ✅ Verified working (209 noise events caught during 05-01 storm at NF=0; TRCO+SRCO both calibrated OK) |
| AS3935 publisher | ✅ ESP32 bridge ([`vu2cpl-as3935-bridge`](https://github.com/vu2cpl/vu2cpl-as3935-bridge)) live since 2026-05-11; **v0.2.0** since 2026-05-12 adds an MQTT cmd channel (`lightning/as3935/cmd` + `cmd/ack`) covering all tunables + `calibrate_tun_cap` action, NVS-persisted, range-validated. Indoor `as3935.service` on noderedpi4 stopped + disabled (kept as fallback). MQTT status/hb/event contract still wire-compatible with the original Python daemon |
| Disconnect logic | ✅ **Distance-graded as of 2026-05-12, regression-fixed 2026-05-13.** 3×3 matrix (AS3935 close/medium/far × OM cold/lit/severe). OM no longer fires DC directly — only corroborates AS3935 hits in medium / far zones. Close zone (<10 km) still single-hit-fires. 7 cfg keys in Init Defaults. Full matrix table in CLAUDE.md "Lightning Antenna Protector" section. **2026-05-13 audit** found yesterday's `76d60e5` had silently broken real AS3935 disconnects via a `source !== 'AS3935'` strict-equality filter (actual source string is `'AS3935 (local)'`); event log + JSONL kept writing "DISCONNECT triggered" while no MQTT was actually published. Filter relaxed to reject only `Open-Meteo`; AS3935 / TEST / future sources all pass through the matrix. Same audit bundled 10 follow-up fixes (dead `Within threshold?` switch removed, reconnect-timer cancellation on manual paths, bypass-aware disconnect log, 3 stray `node.warn`s stripped). Lightning tab 76 → 75 nodes. SHACK_CHANGELOG.md 2026-05-13 entry has the full account. |
| AS3935 Control Panel | ✅ New ui_template on flow tab `AS3935 Tuning` (id `fe70cfdcdfa19aa4`); dashboard group `as3935_ctl_grp`. Exposes NF / WDTH / SREJ / TUN_CAP / Mask dist / AFE GB / Min strikes / Modem sleep + actions (Calibrate TUN_CAP / Republish / Reboot / Factory Reset WiFi). Matches GitHub-dark palette + Pattern-B IIFE (`(function(scope){…})(scope)`) |
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
| 1 | Move AS3935 antenna **outdoors** | Hardware. **Major progress 2026-05-11**: ESP32 bridge ([`vu2cpl-as3935-bridge`](https://github.com/vu2cpl/vu2cpl-as3935-bridge) v0.1.1) running on the bench, indoor Pi daemon retired. Still indoors though — physical install (enclosure seal, 18650+TP4056+solar power chain, shade mount, post-install TUN_CAP re-tune) is the remaining work to regain the rated 40 km range |
| 2 | ~~AS3935 systemd unit hardening~~ | **Done 2026-05-10** (`c3f55a8`) — directives baked into the base `as3935.service` unit (simpler than a drop-in for a unit we own). `After=network-online.target mosquitto.service`, `Wants=network-online.target`, `Restart=on-failure`, `RestartSec=5`. Verified live |
| 3 | ~~Open-Meteo dashboard placeholder~~ | **Obsolete 2026-05-10** — the badge this referred to (`OPEN-METEO MONITOR · Waiting for data…` in the Master Dashboard `#hdr` block) was removed during the 2026-05-08 Shack-tab merge. OM polls already produce `type:'log'` messages that flow into the event log via Parse Open-Meteo output 2. No code change needed |
| 4 | ~~Format Log cosmetic~~ | **Done 2026-05-10** (`f15cad8`) — `(msg.distance != null) ?` instead of truthy ternary; 0 km strikes (AS3935 overhead/out-of-range) now render `\| 0 km` |
| 14 | Power meter panels redesign | **Done 2026-05-10** (`a2e6115`) — LP-700 + SPE WS Output Power bars: 10 px height (was 6 px), auto-scale 5/25/50/100/500/1000/1500/2000/5000 W, scale indicator next to header. LP-700: AVG=green, PEAK=amber, SWR keeps its threshold logic. SPE WS: removed redundant `0W / pwrMax W` text. Initial dynamic-threshold colour scheme on LP-700 power bars was reverted — auto-scale + dynamic % colours don't compose (bar always near top of its band → colour stuck at amber). |
| 15 | ~~DXCC alert-table dedup~~ | **Done 2026-05-10** (`8965d8e`) — `Format Alert for Dashboard Table` filter now drops existing rows matching `call+band+mode+alertType` before unshift. Combined with TTL expiry into a single pass. Identical spots re-firing after the 60 s upstream dedup window no longer double-render — the existing row gets replaced with the latest timestamp/freq/spotter |
| 5 | ~~Rotator timer 60s → 5min~~ | **Done 2026-05-10** (`971f4b4`) — `05f0ddeb566a90fc` body now `var duration = 5 * 60 * 1000` + status badge updated to "Timer running — 5 mins" |
| 6 | Mac SwiftUI app scaffold | Per CLAUDE.md TODO #12 — not started. Path now `~/projects/vu2cpl-shack-app/` (was `~/Documents/...`) |
| 7 | ~~Blitzortung real-time integration~~ | **Dropped 2026-05-10**, dead code stripped **2026-05-11** (`e8a2dd4`) — verified zero coverage at MK83TE on map.blitzortung.org. Sparse south-India contributor stations make TOA triangulation unreliable in this region. AS3935 (close-range) + Open-Meteo CAPE (regional) cover the operational need. Parser Cases 2/3 in `Parse Strike` (Buffer/string TCP payload parser, ~30 lines including `findKey` + `readCoord` helpers) deleted from the function body; CASE 1 (object payloads — test injects + Parse Open-Meteo) is the only path now |
| 8 | DXCC backlog (pending #6–11 in CLAUDE.md) | Filter persistence, separate CW/Ph/Data fetches, non-project-folder path support, README+PDF, Club Log API ban verification, daily 02:00 inject wiring |
| 9 | ~~Add `gpsntp` to RPi Fleet `httpDevices`~~ | **Done 2026-05-10** — `'gpsntp': 'http://gpsntp.local:7799'` added to `Route CMD: HTTP or MQTT` (`a0695975fec84e2c`). Reboot/shutdown buttons functional via the existing fleet-card mechanism |
| 10 | ~~Watch `gpsntp` through a U3S TX session~~ | **Closed 2026-05-11 (no issue)** — operator verified `gpsntp.local` holds stratum-1 PPS lock through **1 kW** SPE amplifier transmissions (well above the U3S WSPR power level that was the original concern). QLG1 patch antenna is not RFI-desensitised by the shack's high-power TX. Dedicated NEO-M8N fallback (documented in `pi-gps-ntp-server/HANDOVER.md`) is not needed |
| 11 | ~~Optional: chrony metrics on Shack dashboard~~ | **Done 2026-05-10** — Chrony status card landed via `743a0d8` + `286348e` migration to single `ui_template`; placement on `Shack Monitoring tools` → `Network Monitor` group |
| 12 | ~~Install `log2ram` on `gpsntp`~~ | **Done 2026-05-11** — azlux repo (`trixie main`, not `bookworm main` as BUILD.md said — gpsntp moved to Debian 13), `log2ram` installed + enabled, rebooted. `/var/log` now tmpfs 128 MB; chrony re-locked to stratum 1 with PPS within ~60 s of boot. BUILD.md upstream fix landed in [`pi-gps-ntp-server@5b115ba`](https://github.com/vu2cpl/pi-gps-ntp-server/commit/5b115ba) — release-agnostic `${VERSION_CODENAME}` + explicit reboot step |
| 13 | ~~Delete orphan `GPS NTP` flow tab~~ | **Done 2026-05-10** — operator deleted the empty tab; closed in next `nrsave` |
| 16 | ~~Clear LP-700-HID ws tab Description field~~ | **Done 2026-05-11** (`72fc31e`) — initially marked won't-do as cosmetic, but operator cleared it via editor → tab Properties → Description → empty → Deploy → commit. Tab sidebar is now blank (was 419 chars of legacy `npm install robertsLando/node-red-contrib-usbhid` + telepost udev notes from the pre-WS-gateway era) |
| 17 | ~~Fold DXCC extract regen into `nrsave` alias~~ | **Done 2026-05-11** — `nrsave` was an alias on `~/.bashrc:114`; converted to a bash function that runs the rule #4 extract regen before `git add`, then stages flows.json + the extract together. `~/.bashrc.bak.YYYYMMDD_HHMM` backup retained on Pi. CLAUDE.md rule #4 reworded to note nrsave handles it automatically; REBUILD_PI.md + rebuild_pi.sh updated so a fresh rebuild lands the same function definition (was carrying a stale `git save`-based variant) |
| 18 | ~~Club Log API ban verification (CLAUDE.md TODO #10)~~ | **Closed 2026-05-11** — ban lifted, confirmed by operator + verified live (`nr_dxcc_seed.json.updated` = 2026-05-11T03:27:47Z, written by the daily 02:00 cron). No flow change: `once: false` on the startup injects is the right defence — one fetch per day via cron, ad-hoc refreshes via `POST /dxcc/refresh`. CLAUDE.md TODO #10 row reworded, Data files list corrected (modes lives inside seed, maps comes from cty.xml runtime) |
| 19 | ~~DXCC filter persistence (CLAUDE.md TODO #6)~~ | **Closed 2026-05-11** — verified end-to-end. Two-part fix: (a) `enable_file_context.sh` had never actually run on this Pi — its idempotency check was matching the commented template `localfilesystem` mention in stock settings.js, and its substitution block was a single-store design that would have routed all no-scope traffic to disk. Rewrote to install two named stores (`memory` default + `file` localfilesystem), fixed the idempotency check (`^\s+contextStorage:` anchor), ran it on the Pi. (b) Aligned 5 reader function bodies (`DXCC Prefix Lookup + Alert Classify`, `Format Alert for Dashboard Table`, `Format FlexRadio Spot Command`, `Format Telegram Alert Dedup 10 minute`, `Format Telegram Alert`) to use `'file'` scope on their 32 filter*/spotTTL `flow.get` calls, matching the writer in `Save Alert Filters HTTP`. Tested: toggle a filter chip → restart Node-RED → fire matching TEST inject → no alert (suppressed as expected) → re-enable → fires |
| 20 | ~~DXCC worked-table dual-write bug~~ | **Misdiagnosis 2026-05-11 — closed without code change.** While investigating #19 I scanned for `'file'`-scope writes in `Fetch All Modes + Parse` and reported it as file-only. Wrong: the function does *triple* persistence — memory writes (L85-88, no scope), file context writes (L91-94, `'file'`), AND a direct `fs.writeFileSync` to `nr_dxcc_seed.json` (L96-103). Architecture has been correct all along; today's fix to enable the file context store just makes the L91-94 writes actually land where they always intended. Lesson: filtering tool searches by a single scope hides the parallel writes; always scan full function bodies when assessing dual-write integrity |
| 21 | ~~AS3935 outdoor sensor — ESP32 firmware project~~ | **v0.2.0 live on the bench 2026-05-12** ([`vu2cpl-as3935-bridge`](https://github.com/vu2cpl/vu2cpl-as3935-bridge)). v0.1.1 bench bring-up done 2026-05-11; v0.2.0 same day added the full MQTT cmd channel (subscribes `lightning/as3935/cmd`, acks on `cmd/ack`), NVS persistence of all tunables, range validation, on-device TUN_CAP sweep as the `calibrate_tun_cap` action (port of `as3935_tune.py` w/ MQTT keepalive pumped inside the 35 s loop), and a no-publish watchdog → `ESP.restart()`. Still open for v0.3.0+: sleep-on-IRQ for battery mode + OTA. Hardware-outdoors install (HANDOVER #1) still pending — enclosure / power chain / field TUN_CAP retune |
| 22 | Distance-graded disconnect | **Done 2026-05-12** ([`76d60e5`](https://github.com/vu2cpl/vu2cpl-shack/commit/76d60e5)) — 3×3 matrix (AS3935 close/medium/far × OM cold/lit/severe) implemented in `Trigger Disconnect`. OM no longer directly fires DC; serves only as corroboration. 7 cfg keys live-tunable from `Init Defaults`. Matrix + thresholds documented in CLAUDE.md "Lightning Antenna Protector" section. Net behaviour shift: fewer false-positive DCs during high-CAPE-no-storm Bengaluru afternoons; close-zone single-hit still fires (deliberate, safety-first) |
| 23 | AS3935 Control Panel ui_template | **Done 2026-05-12** — new self-contained admin panel on flow tab `AS3935 Tuning` (`fe70cfdcdfa19aa4`). Exposes all v0.2.0 firmware tunables + actions. Pattern-B IIFE `(function(scope){…})(scope)`. Survived a scope-binding refactor bug ([`7d205c1`](https://github.com/vu2cpl/vu2cpl-shack/commit/7d205c1)) and a rollback-tab pattern experiment (kept old tab disabled for 1 day as insurance, then deleted). GitHub-dark palette matching chrony card |

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
- `26ddff0cbbfe5fc1` Parse Strike (handles object payloads from OM + test injects; Blitzortung Buffer/string parser stripped 2026-05-11 `e8a2dd4`)
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
- **DXCC blacklist has no off-Pi backup since 2026-05-13** ([`b1fbef9`](https://github.com/vu2cpl/vu2cpl-shack/commit/b1fbef9) public-prep). `nr_dxcc_blacklist.json` is `.gitignore`d to avoid publishing the muted-callsigns list. Deliberate trade-off — accept that a Pi disk failure means the list evaporates and gets repopulated from memory. List is small (<20 entries typically), recoverable. If it ever grows large enough to be painful to lose, set up a periodic rsync to the Mac. Same `.gitignore` reasoning applies to `nr_dxcc_seed.json` and `nr_lightning_events.jsonl`, but those are runtime caches — Club Log / AS3935 events recreate them naturally, no loss.

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
