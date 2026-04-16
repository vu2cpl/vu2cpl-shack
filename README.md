# VU2CPL DXCC Tracker v7

Node-RED Shack Automation — Reference Document  
VU2CPL · Manoj · Bengaluru · MK83TE · Licensed 1993 · 9× BDXCC

---

## Overview

The DXCC Tracker monitors DX cluster spots in real-time against Club Log worked data and fires alerts for new DXCC entities, new bands, and new modes. All processing runs inside Node-RED on a Raspberry Pi — no external Python scripts required.

The flow connects to a DX cluster via TCP, parses spots, resolves DXCC prefix via cty.xml, classifies against worked/confirmed data from Club Log, and sends alerts to the Node-RED dashboard, MQTT, FlexRadio, and Telegram.

---

## Architecture

DX Cluster TCP → Login+Parse+Dedup → DXCC Prefix Lookup → Alert Classify → Dashboard + MQTT + FlexRadio + Telegram

- cty.xml downloaded and parsed inside Node-RED (HTTP + zlib decompression)
- Club Log API fetched directly via https lib (modes 0–3, `deleted=0`)
- Dashboard controls use `fetch()` + HTTP-in nodes — `send()` not used
- Filter state persists via localStorage (browser) + Node-RED file context store

---

## Key Node IDs

**Tab ID:** `d110d176c0aad308`

| Node Name | ID |
|-----------|-----|
| DXCC Dashboard (ui_template) | 38a6451a95a57685 |
| Format Stats for UI | bb17fc08553256e0 |
| Format Alert for Dashboard | 2286f0a512733e92 |
| DXCC Prefix Lookup | b981643f37259f89 |
| Fetch All Modes + Parse | 9fd52c02a8486dce |
| Build Club Log API Request | 6e60f619acad462e |
| Login + Parse + Dedup | d301158172785aba |
| Clear Alert List | 06e09f7c1cf8c86a |
| Blacklist Manager | bf47f506a324b481 |
| Blacklist Filter | caa799bd4a340929 |
| ⚙️ Credentials (edit once) | 08dcd5378a79bb18 |

---

## HTTP Endpoints (all POST)

| Endpoint | Function |
|----------|----------|
| `/dxcc/filters` | Save band/type/mode/TTL filters |
| `/dxcc/refresh` | Trigger Club Log re-fetch |
| `/dxcc/clear` | Clear alert table |
| `/dxcc/blacklist-remove` | Remove callsign from blacklist |

Pattern: `oninput` → `fetch('/endpoint', {method:'POST', body:JSON.stringify({value:v})})` → http-in → function → http response 200.

---

## Dashboard Features

ui_template — width 24, group `grp_dxcc_stats`

| Feature | Detail |
|---------|--------|
| Band filters | 160M–6M (10 bands) with All/HF presets |
| Alert types | NEW DXCC (red) / NEW BAND (blue) / NEW MODE (amber) |
| Mode filters | CW / Phone / Data |
| Spot lifetime | Slider 5–60 min |
| Block callsign | Type + Block button |
| Unblock | Click callsign tag in blocked list |
| Refresh | Triggers Club Log re-fetch via /dxcc/refresh |
| Clear | Empties alert table via /dxcc/clear |
| Persistence | localStorage (browser) + file store (Pi reboot) |

---

## Credentials — Edit Once

Open the **⚙️ Credentials** node and set:

```javascript
var cfg = {
    cl_apikey   : 'YOUR_CLUBLOG_API_KEY',
    cl_email    : 'your@email.com',
    cl_password : 'your_clublog_password',
    cl_callsign : 'YOUR_CALLSIGN',
    tg_token    : 'YOUR_TELEGRAM_BOT_TOKEN',
    tg_chat_id  : 'YOUR_CHAT_ID'
};

// Flows directory — change for non-projects users:
// flow.set('cfg_flows_dir', os.homedir() + '/.node-red');
flow.set('cfg_flows_dir', os.homedir() + '/.node-red/projects/vu2cpl-shack');
```

All values are stored in flow context automatically. No other nodes need editing.

The `cfg_flows_dir` setting controls where `nr_dxcc_seed.json` and `nr_dxcc_blacklist.json` are written and read. For non-projects users change it to `os.homedir() + '/.node-red'`.

---

## Club Log Data — Persistence & Daily Refresh

`Fetch All Modes + Parse` saves to two places on every successful fetch:

- **Flow context (RAM)** — used at runtime for alert lookups
- **File context store** — survives Pi reboot, restored instantly by Bootstrap
- **`nr_dxcc_seed.json`** — written to `cfg_flows_dir` path

### Startup recovery sequence

1. Bootstrap checks file store (fastest, survives reboot)
2. File store empty → reads `nr_dxcc_seed.json` from `cfg_flows_dir`
3. Fallback: `~/.node-red/nr_dxcc_seed.json`
4. Club Log fetch fires at 12s → updates RAM and seed file

### Daily refresh

Inject node fires at **02:00 daily** (crontab `0 2 * * *`) → `Build Club Log API Request`. Keeps worked data fresh and recovers from any failed startup fetch.

### Club Log API parameters

- `deleted=0` — current entities only
- `mode=0,1,2,3` — all modes fetched in parallel
- Bands scanned: **160, 80, 40, 30, 20, 17, 15, 12, 10, 6M**

### Failure handling

| Scenario | Recovery |
|----------|----------|
| Club Log unreachable at startup | Retry at 90s |
| Both startup fetches fail | Bootstrap uses file store / seed file |
| Pi reboot | Bootstrap restores from file store instantly |
| Data goes stale | Daily 02:00 refresh |

---

## Filter Persistence

- Every button/slider saves to localStorage immediately
- `fetch()` also POSTs to `/dxcc/filters` → Node-RED file context store
- On page load: localStorage restored at 500ms, pushed to Node-RED
- Survives: page refresh, browser restart, redeploy, Pi reboot

Requires file context store enabled in `settings.js`.

---

## dxccReady Flag

Controls whether DXCC Prefix Lookup processes spots. Set `false` only at startup, set `true` by `Fetch All Modes + Parse` on success. Parse/retry nodes do NOT touch this flag.

---

## Startup Sequence

| Step | Delay | Action |
|------|-------|--------|
| 1 | 0.5s | Credentials → set all cfg_* flow variables incl. cfg_flows_dir |
| 2 | 2s | Bootstrap → restore from file store OR load nr_dxcc_seed.json |
| 3 | 3s | Load blacklist → restore blocked callsigns |
| 4 | 5s | Load cty.xml → download + parse → ~340 entities |
| 5 | 12s | Load Club Log → fetch modes 0–3 → sets dxccReady=true |
| 6 | 90s | Retry Club Log (if step 5 failed) |
| 7 | 02:00 | Daily inject → re-fetch Club Log |

---

## Files on Pi

| File | Purpose |
|------|---------|
| `flows.json` | Main Node-RED flow (git tracked) |
| `clublog_dxcc_tracker_v7.json` | DXCC tab export (synced on every commit) |
| `nr_dxcc_seed.json` | Worked/confirmed seed — written by flow |
| `nr_dxcc_blacklist.json` | Blocked callsigns |
| `README.md` | This document |
| `DXCC_Tracker_README.pdf` | PDF version (regenerated with README) |
| `enable_file_context.sh` | One-time setup for file context store |

---

## Standard Commit Sequence

Run on Pi after every change:

```bash
cd ~/.node-red/projects/vu2cpl-shack
python3 -c 'import json; d=json.load(open("flows.json")); v=[n for n in d if n.get("z")=="d110d176c0aad308" or n.get("id")=="d110d176c0aad308"]; json.dump(v,open("clublog_dxcc_tracker_v7.json","w"),indent=2); print(len(v),"nodes")'
git add flows.json clublog_dxcc_tracker_v7.json README.md DXCC_Tracker_README.pdf
git commit -m "v7: <description>"
git push
```

---

## Setup — Node-RED File Context Store

Required for filter and worked data persistence across Pi reboots.

```bash
bash ~/enable_file_context.sh
node-red-stop && node-red-start
```

Manual `settings.js` change:
```javascript
contextStorage: { default: { module: 'localfilesystem' } },
```

---

## Technical Reference

| Item | Value |
|------|-------|
| Tab ID | d110d176c0aad308 |
| MQTT broker | 192.168.1.169:1883 |
| FlexRadio | 192.168.1.148:4992 |
| Telegram bot | @nrdxccbot |
| Dedup window | 60s per callsign + frequency |
| cty.xml | cdn.clublog.org/cty.php?api=... |
| Club Log API | clublog.org/json_dxccchart.php |
| Repo | github.com/vu2cpl/vu2cpl-shack |
| Flow file | clublog_dxcc_tracker_v7.json |

---

## Station

| Item | Detail |
|------|--------|
| Radio | FlexRadio FLEX-6600, RGO One, Icom IC-705 |
| Amplifier | SPE Expert 1.5 KFA |
| Antennas | Hex beam, 160m inverted-L, 6m LFA Yagi, Beverage/N6RK/K9AY receive |
| Awards | 9× BDXCC |
| DXpeditions | VU7T, VU7MS (Lakshadweep), AT5P (Rameshwaram) |
| Grid | MK83TE — Bengaluru |
| Licensed | Since 1993 |
