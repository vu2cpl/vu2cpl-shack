# VU2CPL DXCC Tracker — Node-RED Flow

Real-time DX cluster monitor that alerts you to new DXCC entities, new modes, and new bands based on your confirmed log from Club Log.

**Author:** VU2CPL Manoj — Bengaluru, India (MK83TE)  
**Version:** 7 | April 2026  
**Status:** Working

---

## What's New in v7

- **cty.xml parsed in Node-RED** — downloads and parses Club Log cty.xml directly via HTTP + zlib. No Python scripts or disk files for prefix maps.
- **ADIF numbers throughout** — Club Log's native ADIF keys used end-to-end. No conversion table. IT9 resolves to Italy automatically via cty.xml exceptions.
- **All Club Log fetching in Node-RED** — fetches mode=0,1,2,3 via Node.js https lib. No shell scripts, no cron jobs.
- **Startup alert suppression** — alerts paused until both cty.xml and Club Log data fully loaded (~12s). No false NEW DXCC floods on deploy.
- **Resilient fallback** — if Club Log is unreachable, falls back to seed data and enables alerts. Auto-retry at 60s (cty.xml) and 90s (Club Log).
- **Bogus callsign filtering** — callsigns resolving to unknown ADIF entities silently dropped.
- **Mode filter buttons** — toggle CW / Phone / Data alerts independently from dashboard.
- **FlexRadio spot colour coding** — NEW DXCC=red, NEW MODE=amber, NEW BAND=blue in SmartSDR bandmap.
- **Better portable call handling** — splits on /, skips /P /M, picks longest matching prefix.

---

## Features

- Monitors 4 DX clusters simultaneously via TCP
- Alerts: NEW DXCC → NEW MODE → NEW BAND (priority order)
- Dashboard table with band / mode / alert type filters
- Mode filter buttons: CW / Phone / Data toggle on dashboard
- FlexRadio FLEX-6600 spot injection with alert-type colour coding
- Telegram alerts via bot
- MQTT publish for external integrations
- Blacklist to suppress specific callsigns
- Startup suppression — no false alerts during reference data load
- Club Log fallback — uses seed data if API unreachable, auto-retries
- ITU callsign validation — blocks 0xx, 1I-style garbage callsigns
- DXCC entity validation — spots with unknown prefixes silently dropped

---

## Files

| File | Purpose |
|------|---------|
| `clublog_dxcc_tracker_v7.json` | Node-RED flow — import this |
| `nr_dxcc_seed.json` | Bootstrap worked table (fallback if Club Log unreachable) |
| `DXCC_Tracker_README.pdf` | This document |

**No longer needed (delete from Pi):**
- `fetch_clublog.sh`
- `generate_dxcc_maps.py`
- `nr_dxcc_maps.json`
- `nr_dxcc_live.json`
- `nr_dxcc_modes.json`
- `cty.dat`

---

## Installation

### Prerequisites

- Node-RED with `node-red-dashboard` installed
- Club Log account with API key
- Telegram bot token (optional)

### Step 1 — Copy seed file to Pi

```bash
cp nr_dxcc_seed.json \
  /home/vu2cpl/.node-red/projects/vu2cpl-shack/
```

### Step 2 — Edit Credentials node

Open Node-RED, double-click **Credentials (edit once)** and fill in:

| Key | Value |
|-----|-------|
| `cl_apikey` | Your Club Log API key |
| `cl_email` | Your Club Log email |
| `cl_password` | Club Log application password |
| `cl_callsign` | Your callsign (e.g. VU2CPL) |
| `tg_token` | Telegram bot token |
| `tg_chat_id` | Your Telegram chat ID |

### Step 3 — Import flow and deploy

**Menu → Import → select clublog_dxcc_tracker_v7.json → Full Deploy**

### Step 4 — Verify startup sequence

| Time | Node | Expected status |
|------|------|----------------|
| 0.5s | Credentials | Config loaded |
| 2s | Bootstrap Worked Table | 319 entities, 2386 slots |
| 5s | Parse cty.xml | 340 entities \| 2934 prefixes \| 8941 exceptions |
| 12s | Fetch All Modes + Parse | 319 entities \| 2340✓ 170✗ \| modes OK |
| 12s+ | DXCC Prefix Lookup | alerts enabled |
| 60s | Retry cty.xml | only fires if 5s attempt failed |
| 90s | Retry Club Log | only fires if 12s attempt failed |

---

## Resilience / Offline Behaviour

| Scenario | Behaviour |
|----------|-----------|
| Club Log API unreachable | Falls back to seed data, sets dxccReady=true, alerts fire |
| cty.xml unreachable | Alerts paused, auto-retry at 60s |
| Both unreachable | Alerts paused until retry succeeds |
| No seed file on disk | Alerts paused until Club Log loads |

---

## DX Cluster Connections

| Name | Host | Port |
|------|------|------|
| N2WQ-2 | `cluster.n2wq.com` | 8300 |
| VU2OY | `103.153.92.118` | 7550 |
| VU2CPL | `vu2cpl.ddns.net` | 7550 |
| VE7CC | `ve7cc.net` | 23 |

---

## Alert Logic

| Priority | Condition | Alert | Colour |
|----------|-----------|-------|--------|
| 1 | Entity never worked | NEW DXCC | Red |
| 2 | DXCC worked, not this mode | NEW MODE | Amber |
| 3 | DXCC+mode worked, not this band | NEW BAND | Blue |
| — | All worked | Suppressed | — |

**Mode categories:** Phone (USB/LSB/SSB/AM/FM) | CW | Data (FT8/FT4/RTTY/PSK31/JS8)

**Callsign validation:** ITU pattern — blocks 0xx, 1I-style, unknown DXCC entities. Handles VU22AR format and portable calls (VK2/G7VJR, G7VJR/P).

---

## Dashboard Controls

### Band Filter
Default: 80M–10M. Buttons: All / HF / VHF.

### Mode Filter
Three toggles (all ON by default):

| Button | Suppresses |
|--------|-----------|
| CW | CW spots |
| Phone | USB/LSB/SSB/AM/FM spots |
| Data | FT8/FT4/RTTY/PSK31 spots |

### Alert Types
Checkboxes: NEW DXCC / NEW MODE / NEW BAND.

### Spot TTL
Default 20 minutes. How long alerts stay in table and FlexRadio bandmap.

### Blacklist
Block specific callsigns. Saved to `nr_dxcc_blacklist.json`.

### Refresh Club Log
Re-fetches Club Log matrix directly from API.

---

## FlexRadio Spot Colours

| Alert | Colour |
|-------|--------|
| NEW DXCC | Red (0xFFFF3333) |
| NEW MODE | Amber (0xFFFFAA00) |
| NEW BAND | Blue (0xFF3399FF) |

---

## Technical Details

| Item | Value |
|------|-------|
| Tab ID | `63edb94e4f739b69` |
| MQTT broker | `192.168.1.169:1883` |
| FlexRadio | `192.168.1.148:4992` |
| Telegram bot | `@nrdxccbot` |
| Dedup window | 60s per callsign + frequency |
| cty.xml source | `cdn.clublog.org/cty.php?api=...` |
| Club Log API | `clublog.org/json_dxccchart.php` |

---

## Station

- **Radio:** FlexRadio FLEX-6600, RGO One, Icom IC-705
- **Amp:** SPE Expert 1.5 KFA
- **Antennas:** Hex beam, 160m inverted-L, 6m LFA Yagi, Beverage/N6RK/K9AY receive
- **Awards:** 9x BDXCC
- **DXpeditions:** VU7T, VU7MS (Lakshadweep), AT5P (Rameshwaram)
- **Grid:** MK83TE | Licensed since 1993
