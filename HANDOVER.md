# Session Handover — VU2CPL Shack

**Period:** 2026-05-01 → 2026-05-07
**Operator:** Manoj VU2CPL · MK83TE · Bengaluru
**Last commit at handover:** `497ccf3`

---

## Repo state

```
~/projects/vu2cpl-shack    main @ 497ccf3   clean, in sync with origin
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

---

## Current system state

| Subsystem | State |
|-----------|-------|
| AS3935 chip + I²C + IRQ wire to GPIO4 | ✅ Verified working (209 noise events caught during 05-01 storm at NF=0; TRCO+SRCO both calibrated OK) |
| AS3935 daemon (`as3935.service`) | ✅ Running with NF=4 production setting, indoor antenna mode |
| Open-Meteo CAPE polling (every 5 min) | ✅ Auto-fires disconnect when CAPE ≥ 800 J/kg or `weather_code ∈ {95,96,99}` |
| Antenna + radio auto-disconnect chain | ✅ Verified end-to-end during 05-01 storm |
| Dashboard refresh persistence (log + map + AS3935) | ✅ All three replay within 30 s of page load |
| Master Dashboard handlers | `as3935_ready`, `as3935_hb`, `as3935_status`, `strikes_replay`, `log` all present |
| HA Pi monitoring | ✅ Implemented via HA-side automation (no Node-RED changes — `mqtt.publish` to `rpi/HassPi/*` every 30 s) |

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
