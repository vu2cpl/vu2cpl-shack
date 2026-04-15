# VU2CPL Shack Automation — Node-RED

VU2CPL (Manoj), Bengaluru, MK83TE. Licensed since 1993. 9x BDXCC.

---

## Flows

### 1. DXCC Tracker v7
Monitors DX cluster spots against Club Log worked data and fires alerts for new DXCC / new band / new mode.

**Tab ID:** `d110d176c0aad308`

**Key nodes:**
| Node | ID |
|------|----|
| DXCC Dashboard (ui_template) | `38a6451a95a57685` |
| Format Stats for UI | `bb17fc08553256e0` |
| Format Alert for Dashboard | `2286f0a512733e92` |
| DXCC Prefix Lookup | `b981643f37259f89` |
| Fetch All Modes + Parse | `9fd52c02a8486dce` |
| Build Club Log API Request | `6e60f619acad462e` |
| Clear Alert List | `06e09f7c1cf8c86a` |
| Blacklist Filter | `caa799bd4a340929` |
| Blacklist Manager | `bf47f506a324b481` |

**HTTP endpoints (all POST):**
| Endpoint | Function |
|----------|----------|
| `/dxcc/filters` | Save band/type/mode/TTL filters to flow context + file store |
| `/dxcc/refresh` | Trigger Club Log re-fetch |
| `/dxcc/clear` | Clear alert table |
| `/dxcc/blacklist-remove` | Remove callsign from blacklist |

**Dashboard features:**
- Unified sidebar + DX alert table (ui_template, width 24, group `grp_dxcc_stats`)
- Band filters: 160M–2M with All/HF/VHF presets
- Alert type filters: NEW DXCC / NEW BAND / NEW MODE
- Mode filters: CW / Phone / Data
- Spot lifetime slider (5–60 min)
- Block callsign / unblock by clicking tag
- Refresh Club Log / Clear alerts buttons
- Full persistence: localStorage (page refresh) + file store (redeploy/reboot)

**Persistence:**
- All filter state saved to localStorage on every button click
- Also written to Node-RED file context store via `/dxcc/filters` HTTP endpoint
- Restored from localStorage on page load (500ms timeout)
- `dxccReady` only set false at startup — never reset by cty.xml retries

**Startup sequence:**
1. Bootstrap inject (2s) → seed worked table from `nr_dxcc_seed.json`
2. Load cty.xml inject (5s) → download + parse → ~340 entities
3. Load Club Log inject (12s) → fetch modes 0–3 → sets `dxccReady=true`
4. Load blacklist inject → restore blocked callsigns

**Files to keep on Pi:**
- `nr_dxcc_seed.json` — worked table seed
- `nr_dxcc_blacklist.json` — blocked callsigns

---

### 2. Lightning Antenna Protector
Disconnects antenna (powerstrip1/POWER5) and Flex Radio (4relayboard/POWER1) on lightning detection.

**Data sources:** Open-Meteo lightning_potential API (5-min poll) + AS3935 local sensor via MQTT

**HTTP endpoints:**
| Endpoint | Function |
|----------|----------|
| `/lightning/threshold` | Save disconnect threshold (km) |
| `/lightning/reconnect` | Save reconnect timer (min) |
| `/lightning/ant-on` | Force antenna ON |
| `/lightning/radio-on` | Force radio ON |

**Settings (edit Init Defaults node):**
- Grid: MK83TE → lat/lon auto-calculated
- Threshold: 25 km
- Reconnect: 20 min
- Antenna: powerstrip1/POWER5
- Radio: 4relayboard/POWER1

---

### 3. Power Control Panel
All Devices Merged tab. Rotator auto-off timer: 5 min (powerstrip1/POWER2), countdown shown on button.

**Telegram:** HTTP request node — URL must be blank, method POST, `msg.url` set in function node.

---

## Technical Details

| Item | Value |
|------|-------|
| Tab ID (DXCC Tracker) | `d110d176c0aad308` |
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

---

## Setup — Node-RED File Context Store

Required for filter persistence across Pi reboots. By default `contextStorage` is commented out in `settings.js` — without it `flow.set(..., 'file')` calls silently fail and filters only persist via localStorage (browser-side).

**Run once on the Pi:**

```bash
bash ~/enable_file_context.sh
node-red-stop && node-red-start
```

**What it does:**
- Edits `~/.node-red/settings.js` to enable `localfilesystem` context store
- Creates `~/.node-red/context/` directory
- Backs up settings.js before editing
- Idempotent — safe to re-run

**Verify it worked:**
```bash
ls ~/.node-red/context/
# Should show flow context files after Node-RED restarts and filters are saved
```

**Manual settings.js change** (if script fails):
Find the commented `contextStorage` block and replace with:
```javascript
contextStorage: {
    default: {
        module: "localfilesystem"
    }
},
```

---

## Club Log Data — Persistence & Daily Refresh

### How worked data is stored
`Fetch All Modes + Parse` saves to three places on every successful fetch:
- **Flow context (RAM)** — used at runtime for alert lookups
- **File context store** — survives Pi reboot, restored instantly by Bootstrap on startup
- **`nr_dxcc_seed.json`** — written to both `~/nr_dxcc_seed.json` and `~/.node-red/projects/vu2cpl-shack/nr_dxcc_seed.json`

### Startup recovery sequence
On reboot, Bootstrap checks file store first:
- File store has data → restore instantly, no internet needed
- File store empty → load from `nr_dxcc_seed.json`
- Both empty → wait for Club Log fetch at 12s

### Daily refresh
An inject node fires at **02:00 daily** (crontab `0 2 * * *`) → `Build Club Log API Request`.
This keeps worked data fresh and acts as recovery if startup fetch failed.

### Failure handling
| Scenario | Recovery |
|----------|----------|
| Club Log unreachable at startup | Retry at 90s |
| Both startup fetches fail | Bootstrap uses file store / seed file |
| Pi reboot | Bootstrap restores from file store instantly |
| Data goes stale | Daily 02:00 refresh re-fetches and updates all stores |
