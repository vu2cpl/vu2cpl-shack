# Running this shack stack at your station

A comprehensive end-to-end guide for **another ham operator** who wants to
run this shack-automation stack at their QTH. No git, GitHub, or
Node-RED experience assumed — just SSH access to your Pi and your
station details.

This guide is **self-contained**. You do not need to read REBUILD_PI.md,
CLAUDE.md, or any other file to complete a fresh install or an upgrade.
Other docs are referenced only when you hit something this guide
deliberately doesn't cover (e.g. operator-level developer lore).

---

## Quick start (for the impatient)

If you've installed Raspberry Pi services before and just want the
commands:

```bash
# On a fresh Pi (Pi OS Lite 64-bit, SSH'd in):
mkdir -p ~/.node-red/projects
git clone https://github.com/vu2cpl/vu2cpl-shack.git \
  ~/.node-red/projects/vu2cpl-shack
cd ~/.node-red/projects/vu2cpl-shack
bash rebuild_pi.sh                # 60–75 minutes, asks for 3 secrets
# Then open http://<pi-ip>:1880 and edit Init Defaults + TopBar
# (Part A5 in this guide). Open http://<pi-ip>:1880/shack on every
# device, login with the password you set, "Add to Home Screen".
```

If anything fails, the rest of this guide walks through each step
in detail.

---

## What you end up with

After this guide is complete:

- **Web dashboard at `http://<pi-ip>:1880/shack`** — phone, tablet,
  Mac, Windows. PWA-installable as a home-screen app on every device,
  remembered login.
- **Lightning auto-disconnect** — Open-Meteo + local AS3935 sensor (if
  you have one) trigger antenna disconnect via Tasmota MQTT.
  Distance-graded matrix decides when to fire. Operator can also
  manually disconnect with a single click; the antenna stays off until
  manually reconnected (survives Pi reboot).
- **FlexRadio / SPE amp / LP-700 meter / rotator** controls and live
  readouts — skip any you don't have without editing anything.
- **DXCC tracker** — real-time cluster spots → entity classification
  via Club Log → Telegram alerts for new DXCC / band / mode.
- **Power control** — 21 Tasmota outlets across 5 devices, energy
  monitoring, scheduled auto-off (rotator).
- **Solar conditions** — NOAA scales, F10.7, geomagnetic, MUF/foF2,
  GOES X-ray flux.
- **RPi fleet monitor** — CPU, temp, mem, disk, uptime, IP for every
  Pi in your shack. Reboot/shutdown buttons.
- **GPS-disciplined NTP card** — if you have a `gpsntp.local` host
  running [`pi-gps-ntp-server`](https://github.com/vu2cpl/pi-gps-ntp-server).
- **All behind a single username/password** — Safari remembers it
  once.

---

## Before you start

### Hardware checklist

| You need | Notes |
|---|---|
| Raspberry Pi 4B or newer | Pi 5 is fine. Pi 3 is too slow for Node-RED + UI builder. |
| Pi OS Lite 64-bit (Bookworm or newer) | Desktop edition works too; Lite is recommended. |
| SSH access to the Pi | From your laptop/desktop. |
| Stable network | Pi on Ethernet preferred; WiFi is fine for setup. |
| At least one Tasmota-flashed power switch | For the antenna. Sonoff S31, Athom, or any Tasmota relay works. |
| **Optional:** lightning sensor (AS3935) | DFRobot module — bench-bring-up only, outdoor install is your project. |
| **Optional:** FlexRadio / SPE amp / Rotor-EZ rotator / LP-700 meter | Each card is independent — skip whichever you don't have. |
| **Optional:** GPS-disciplined NTP Pi | See [`pi-gps-ntp-server`](https://github.com/vu2cpl/pi-gps-ntp-server). |

### Credentials & info checklist

Have these ready before Part A5 (customization):

| You need | Example | Where it goes |
|---|---|---|
| **Your callsign** | `K1ABC` | Init Defaults + DXCC Credentials + Vue TopBar |
| **6-character grid square** | `FN42aa` — use [k7fry.com/grid](http://www.k7fry.com/grid/) if unsure | Init Defaults (lat/lon derived automatically) |
| **MQTT broker IP** | Usually your Pi's own IP, e.g. `192.168.1.50` | Init Defaults |
| **Antenna power Tasmota topic** | e.g. `shack-power` / `POWER3` | Init Defaults |
| **Club Log account + API key** (optional) | From [clublog.org](https://clublog.org) → Settings → API keys | systemd secrets file + DXCC Credentials node |
| **Telegram bot token + chat ID** (optional) | From `@BotFather` + `@userinfobot` | systemd secrets file |
| **A password** for your dashboard | Choose one | bcrypt hash → settings.js |

### Decisions you'll make during install

**You don't need to pre-configure the script.** It auto-detects your
Pi's username and hostname from `id -un` and `hostname` — whatever
user you SSH in as is the user it configures the Pi for. All file
paths, sudoers entries, MQTT topic prefixes, and ssh-key comments
derive from those automatically.

**One optional edit** if you happen to have your own GitHub fork
(most forkers don't bother — `git pull` from upstream forever works
fine for personal use):

```bash
readonly REPO_URL='https://github.com/vu2cpl/vu2cpl-shack.git'  # ← your fork URL
```

Leave it alone otherwise. The script clones from VU2CPL's upstream
and `git pull` brings in new features.

---

# Part A — Fresh install (90 minutes total)

This is the path if you have a blank Pi and want a working dashboard
from scratch. If you already have a working older version and just
want the latest, **skip to Part B**.

## A1. Get the Pi ready (15 minutes)

1. Flash Pi OS Lite 64-bit (Bookworm or newer) to an SD card with
   `raspberry-pi-imager`. Pre-configure:
   - Hostname (whatever you want — `shackpi`, `noderedpi`, etc.)
   - Username + password
   - Enable SSH (password or key-based)
   - WiFi credentials if not on Ethernet
2. Boot the Pi. Wait ~2 minutes for first-boot setup.
3. SSH in from your computer:
   ```bash
   ssh <your-user>@<your-pi-ip>
   ```
4. Verify network + DNS:
   ```bash
   ping -c2 1.1.1.1
   ping -c2 github.com
   ```

## A2. Clone the repo to the correct location (1 minute)

```bash
mkdir -p ~/.node-red/projects
git clone https://github.com/vu2cpl/vu2cpl-shack.git \
  ~/.node-red/projects/vu2cpl-shack
```

> **Why this exact path?** Node-RED's Projects feature serves the
> `/shack` dashboard from `~/.node-red/projects/<repo-name>/`.
> If you clone anywhere else, Node-RED won't see your repo and
> the dashboard customizations later won't take effect. This is
> the single most common forker pitfall — **always clone here**.

If you've **already cloned to a different location** (e.g.
`~/vu2cpl-shack/` from following an older version of this guide),
move it to the correct path:

```bash
sudo systemctl stop nodered 2>/dev/null
mv ~/vu2cpl-shack ~/.node-red/projects/vu2cpl-shack
```

## A3. (Optional) Edit `rebuild_pi.sh` for your GitHub fork (1 minute)

**Most forkers skip this step entirely.** The script auto-detects
your Pi's username + hostname from the running system — no editing
needed. Your callsign / grid / MQTT broker / Tasmota topic come in
during Stage 13's interactive prompts.

The only reason to edit `rebuild_pi.sh` at all is if you have your
own GitHub fork of this repo and want the script to clone from
yours instead of VU2CPL's:

```bash
cd ~/.node-red/projects/vu2cpl-shack
nano rebuild_pi.sh
```

Find the **Fork configuration** block near the top (around line 50):

```bash
readonly REPO_URL='https://github.com/vu2cpl/vu2cpl-shack.git'
```

Change to your fork's URL. Save (`Ctrl+O`, Enter, `Ctrl+X` in `nano`).

> If you don't have your own GitHub fork, **leave this alone** —
> `git pull` from VU2CPL's upstream works forever for personal use.
> You only need a fork if you plan to push changes back.

## A4. Run the install script (60–75 minutes)

```bash
bash rebuild_pi.sh
```

The script runs **14 stages** in order. Each one is idempotent — if it
was already done (state file at `~/.rebuild_pi.state`), it prints
"already done — skipping" and moves on. So you can re-run safely.

| Stage | What it does | Typical time |
|---|---|---|
| 1 — apt packages | Installs system packages: build-essential, git, python3, mosquitto, etc. + sets I2C/SPI/serial on if you have AS3935 hardware. | 5 min |
| 2 — Mosquitto LAN config | Configures Mosquitto MQTT broker to allow anonymous LAN-only access on port 1883. No auth (LAN-only). | 1 min |
| 3 — Node-RED install | Runs the official Node-RED install script. Creates systemd unit. | 8 min |
| 4 — Node-RED palette | npm-installs 10 required palette packages (dashboard, uibuilder, flexradio, etc.). | 12 min |
| 5 — settings.js | Enables Node-RED Projects feature + `localfilesystem` context store + dashboard auth (you'll set the password later). | 1 min |
| 6 — GitHub SSH key | Generates an SSH key for the Pi to push back to your fork (if you have one). Skip if you only ever pull. | 1 min |
| 7 — Clone the repo | Detects your pre-clone from A2 and skips. Otherwise clones now. | 1 min |
| 8 — file context store | Runs `enable_file_context.sh` — patches settings.js to enable the `file` context store for persistent DXCC filters and `manual_off` flag. | <1 min |
| 9 — Pi-side scripts | Installs `/home/<user>/rpi_agent.py`, `monitor.sh`, `power_spe_on.py`, AS3935 daemon (disabled by default), with systemd units + sudoers + cron entries. | 2 min |
| 10 — udev rules | Installs udev rules for LP-700 (`telepost` group) and FTDI serial devices. | <1 min |
| 11 — lp700-server | Clones [`VU3ESV/LP-700-Server`](https://github.com/VU3ESV/LP-700-Server) and installs the WebSocket gateway as a systemd unit (only if you have an LP-700 / LP-500). | 5 min |
| 12 — secrets | Prompts you for Club Log API key, Club Log password, Telegram bot token. Writes them to `/etc/systemd/system/nodered.service.d/secrets.conf` (root-readable only). | 1 min |
| 13 — station customisation | **Always asks "(Re-)customize station identity for this Pi? [y/N]".** Press y → prompts you for callsign, grid, MQTT broker IP, Tasmota antenna topic + channel, threshold, reconnect timer, QTH text. Press Enter → keeps current values. On y: patches Init Defaults in `flows.json` and the TopBar in the Vue dashboard. Also updates `manifest.json`'s `name` for the PWA install. This closes the manual A5.1 + A5.3 + A5.4 steps below into the script. | 2 min |
| 14 — verification | Runs a post-install checklist split into critical (Node-RED responds / project active / flows parsed / `/shack` + `/ui` reachable / `rpi-agent` active / Mosquitto alive) and optional (LP-700 healthz, AS3935 telemetry, GPS-NTP telemetry — skip-not-fail when hardware isn't present). | 2 min |

**While the script runs**, you'll see colored output: green ✓ for
done, yellow for warnings, red for errors. Stage 12 pauses to prompt
for the 3 secrets — paste them at the prompts (input is hidden;
that's normal). If you don't have Telegram or Club Log, just press
Enter for empty.

### What to do if a stage fails

Failures are usually network glitches (`npm install` timing out) or
permission issues. The script prints which stage failed and the exit
code. Just re-run it:

```bash
bash rebuild_pi.sh
```

It resumes from the failed stage. If you want to **force re-run a
specific stage** (e.g. you want to reconfigure Mosquitto), use:

```bash
bash rebuild_pi.sh --stage 2     # forces stage 2 to re-run
```

To **see which stages have completed**:

```bash
bash rebuild_pi.sh --status
```

If a stage repeatedly fails with the same error, that's a real bug
or environment mismatch — see the Troubleshooting section at the
bottom of this guide.

## A5. Tell it about YOUR station (15 minutes)

> **Most of this section is now automated by Stage 13.** If you let
> `rebuild_pi.sh` complete normally, the script already prompted
> you for callsign / grid / MQTT broker / Tasmota topic / threshold /
> reconnect timer / QTH text, patched Init Defaults + the Vue
> TopBar, and updated `manifest.json`. **Skim A5.1 + A5.3 to confirm
> the values look right** — then continue with A5.2 (DXCC creds)
> and A5.4 (Tasmota topics for each device beyond your antenna
> switch). Sections below are the manual fallback if you ever
> need to change values later (re-run with `bash rebuild_pi.sh
> --stage 13` to re-prompt interactively, or edit by hand as
> described).

### A5.1 — Init Defaults (Lightning + identity) — manual fallback

> Stage 13 of `rebuild_pi.sh` does this automatically. Read on
> only if you skipped Stage 13, or want to change values later.

1. Open the Node-RED editor in your browser:
   ```
   http://<your-pi-ip>:1880
   ```
2. **Set the dashboard password first** (one-time, the editor prompts
   you on first visit OR you set it via CLI):
   ```bash
   # On the Pi:
   node-red admin hash-pw
   # Enter your chosen password. Copy the $2y$08$... hash.
   sudo nano ~/.node-red/settings.js
   # Find these 3 places and paste your hash:
   #   adminAuth.users[0].password
   #   httpNodeAuth.pass
   #   ui.auth.users[0].password
   sudo systemctl restart nodered
   ```
   Verify auth is on:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' http://localhost:1880/ui
   # Expect: 401
   ```
3. Log into the editor with the password you set. Open the
   **Lightning Antenna Protector** flow tab (left sidebar).
4. Find the **`Init Defaults ✏️ EDIT HERE`** node (prominently
   labeled with a pencil icon). Double-click to open.
5. Edit the constants at the top of the function:
   ```javascript
   const MQTT_BROKER   = '192.168.1.169';     // ← your Pi's IP
   const CALLSIGN      = 'VU2CPL';            // ← YOUR CALLSIGN
   const GRID_SQUARE   = 'MK83TE';            // ← YOUR 6-char grid

   // Which Tasmota relay controls your antenna power
   const POWER_STRIP   = 'powerstrip1';       // ← your Tasmota topic
   const POWER_CH      = 'POWER5';            // ← which relay (POWER1..5)

   // Optional: same for the radio (set RADIO_ENABLED=true to use)
   const RADIO_ENABLED = false;
   const RADIO_LABEL   = 'Flex Radio';
   const RADIO_STRIP   = '4relayboard';
   const RADIO_CH      = 'POWER1';

   // When to disconnect antenna and how long to wait before reconnect
   const THRESHOLD_KM   = 40;          // disconnect distance, km
   const RECONNECT_MIN  = 20;          // minutes-clear before reconnect
   ```
6. Click **Done** (top-right of the editor), then **Deploy** (red
   button, top-right). The lat/lon for Open-Meteo derives
   automatically from your grid square.

### A5.2 — DXCC tracker credentials (skip if no DX clusters)

If you didn't enter Club Log / Telegram credentials during stage 12,
or want to update them later:

1. Edit the secrets file:
   ```bash
   sudo nano /etc/systemd/system/nodered.service.d/secrets.conf
   ```
   Format:
   ```ini
   [Service]
   Environment="CLUBLOG_API_KEY=<your-key>"
   Environment="CLUBLOG_EMAIL=<your-email>"
   Environment="CLUBLOG_PASSWORD=<your-password>"
   Environment="TELEGRAM_TOKEN=<your-bot-token>"
   Environment="TELEGRAM_CHAT_ID=<your-chat-id>"
   ```
2. Reload + restart:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart nodered
   ```
3. Open the **DXCC Tracker** flow tab. Open **`⚙️ Credentials
   (edit once)`**. Verify callsign:
   ```javascript
   const CL_CALLSIGN     = 'VU2CPL';     // ← YOUR callsign (no SSID)
   const CL_LOGIN_SSID   = '-1';         // ← SSID suffix
   ```
4. Done → Deploy.

> **Don't have Club Log?** Empty `CLUBLOG_*` env vars mean the DXCC
> tab fetches nothing — silently skipped. The dashboard still shows
> the entity classification from cty.xml; only the
> worked/confirmed stats are blank.

> **Don't want Telegram alerts?** Empty `TELEGRAM_TOKEN` means the
> Telegram Router prints a warning to the Node-RED log on every event
> and skips sending. Harmless; no alerts.

### A5.3 — Dashboard callsign in the Vue header — manual fallback

> Stage 13 of `rebuild_pi.sh` does this automatically. Read on
> only if you skipped Stage 13, or want to change values later.

The big callsign + grid display in the top-left of the `/shack`
dashboard:

```bash
nano ~/.node-red/projects/vu2cpl-shack/uibuilder/shack/src/index.js
```

Search for `class="callsign"` (Ctrl+W in nano). You'll find the
**TopBar** Vue component:

```javascript
<span class="callsign">VU2CPL</span>           // ← YOUR callsign
<div class="sub">MK83TE · Bengaluru · ...</div> // ← YOUR grid · city
```

Edit both lines. Save (Ctrl+O, Enter, Ctrl+X).

No restart needed. Hard-refresh `/shack` in your browser:
- **Safari**: hold Shift, click the reload button
- **Chrome/Edge desktop**: `Cmd+Shift+R` (Mac) / `Ctrl+Shift+R` (Win/Linux)

### A5.4 — Tasmota device topics

The default flow expects these Tasmota MQTT topics:

```
stat/powerstrip1/POWER1..5
stat/powerstrip2/POWER1..5
stat/powerstrip3/POWER1..5
stat/4relayboard/POWER1..4
stat/16Amasterswitch/POWER1
```

For each of YOUR Tasmota devices:

1. On the Tasmota web UI → **Configuration → MQTT**:
   - **Host**: your Pi's IP
   - **Topic**: pick a name (e.g. `kitchen-strip`, `shack-power`)
   - **FullTopic**: keep default `%prefix%/%topic%/`
   - Restart Tasmota.
2. In Node-RED, open the **All Power Strips** flow tab. Find the
   `mqtt in` nodes — there's one per topic. Edit each to your topic.
3. In the **Power Control Panel** ui_template (the big button grid),
   edit the device list (top of the function) to match your hardware.
4. Set the **timezone** on each Tasmota device (web UI Console:
   `Timezone +05:30` for India, `Timezone +00:00` for UTC, etc.)
   so the daily energy counter rolls over at local midnight.

## A6. Install the PWA on each device (5 minutes)

Open `http://<your-pi-ip>:1880/shack` on each device, then:

| Device / Browser | How to install |
|---|---|
| **Mac Safari 17+** | File → Add to Dock → Add |
| **iPhone / iPad Safari** | Share → Add to Home Screen → Add |
| **Android Chrome** | ⋮ menu → Install app → Install |
| **Windows / Linux Chrome / Edge** | Address-bar install icon (next to bookmark star) → Install |

Each device prompts for the dashboard password once and remembers it.

## A7. Verify the install (5 minutes)

Open `/shack` on your laptop. You should see:

- [ ] **TopBar** shows YOUR callsign + grid
- [ ] **Lightning card** shows green "ANT ON" chip in collapsed view
- [ ] **Power card** shows your Tasmota devices, click toggle works
- [ ] **AS3935 card** (if you have one) shows ✓ READY, otherwise OFFLINE (expected if no hardware yet)
- [ ] **DXCC card** (if Club Log creds set) shows worked/confirmed stats within ~10 seconds
- [ ] **Footer** shows a build stamp like `v10 · 2026-06-03 …`

On the Pi:
```bash
# All flows loaded without errors:
sudo journalctl -u nodered -n 50 --no-pager | grep -E "Started flows|Unknown type|error"
# Expect: "Started flows" and no "Unknown type" lines
```

If anything's wrong, see Troubleshooting.

You're done with the fresh install. **Skip Parts B & C** unless you
hit specific situations they cover.

---

# Part B — Upgrade an existing install

You're already running this stack from an older commit and want the
latest dashboard + flows. **Total time: 5–15 minutes** depending on
whether you've customized.

## B1. Find where your repo lives (1 minute)

Connect to your Pi:

```bash
ssh <your-user>@<your-pi-ip>
ls -d ~/.node-red/projects/vu2cpl-shack 2>/dev/null   # correct location
ls -d ~/vu2cpl-shack 2>/dev/null                      # old (wrong) location
```

- **Correct location only** → continue to B2.
- **Wrong location only** → move it:
  ```bash
  sudo systemctl stop nodered
  mv ~/vu2cpl-shack ~/.node-red/projects/vu2cpl-shack
  sudo systemctl start nodered
  ```
- **Both exist** → the one Node-RED is actually serving is the one in
  `~/.node-red/projects/`. The other is dead weight; you can
  `rm -rf ~/vu2cpl-shack` to clean up.

## B2. Save your customizations (2 minutes)

```bash
cd ~/.node-red/projects/vu2cpl-shack
git status
```

- **Working tree clean** → continue to B3.
- **Modified files listed** → most likely `flows.json` (you've edited
  Init Defaults / DXCC Credentials / TopBar via the editor + `nrsave`,
  or directly). Stash them:
  ```bash
  git stash push -m "my local customisations before upgrade"
  ```
  This puts your local changes aside without losing them. You can
  reapply later with `git stash pop`.

## B3. Pull the latest (1 minute)

```bash
git pull
```

Three outcomes:

1. **`Already up to date.`** → You're already on the latest. Skip to B7.
2. **Successful fast-forward** with a list of changed files → continue to B4.
3. **`CONFLICT (content): Merge conflict in flows.json`** → upstream
   touched the same lines your stash wanted. See B6.

## B4. Refresh palette nodes (3 minutes)

Even if `git pull` succeeded cleanly, the upstream might reference
**new Node-RED contrib packages** that aren't installed on your Pi.

> **Why this step exists:** `flows.json` references node types by name
> (e.g. `"type": "node-red-contrib-foo"`). If the type isn't installed
> in `~/.node-red/node_modules/`, Node-RED logs `Unknown type` and the
> node won't run. **Palette nodes are NOT installed by `git pull`** —
> they're separate npm packages.

To install any new palette nodes (idempotent — re-runs on the canonical
package list, skips what's already installed):

```bash
bash rebuild_pi.sh --stage 4
```

You'll see lines like `✓ node-red-dashboard already installed`. If
any package was missing, you'll see `step: npm install <package>`
and a 30–60s install. Done.

**How to tell if you actually needed this:** after the next step
(restart Node-RED), check the journal:
```bash
sudo journalctl -u nodered -n 100 --no-pager | grep -i "unknown type"
```
Empty = palette is fine. Any output = re-run stage 4.

## B5. Refresh Pi-side scripts and systemd units (if needed)

Most upgrades touch only flows.json + Vue dashboard files. But some
introduce new **Pi-side scripts** (e.g. `as3935_mqtt.py`,
`monitor.sh`), **systemd services**, **udev rules**, or **sudoers
entries**. Check the changelog to know:

```bash
# See what commits arrived in this pull:
git log --oneline @{1}..@         # commits added between previous and current HEAD
```

Scan the commit messages for words like `new service`, `new
script`, `udev`, `install`, or `systemd`. If any match, re-run the
relevant stages:

```bash
bash rebuild_pi.sh --stage 9     # Pi-side scripts + systemd + sudoers + cron
bash rebuild_pi.sh --stage 10    # udev rules
bash rebuild_pi.sh --stage 11    # lp700-server (if it changed)
```

Each stage is idempotent — it copies files, sets permissions,
restarts the affected service. Safe to re-run.

**If you're not sure**, re-running stages 9 and 10 takes ~30 seconds
total and never breaks anything. Default to running them.

## B6. Resolve flows.json conflicts (only if B3 reported one)

If `git pull` said `CONFLICT (content): Merge conflict in flows.json`,
upstream changed lines your customizations also touched. The
lowest-risk path:

```bash
# Accept upstream's version of flows.json wholesale:
git checkout --theirs flows.json
git add flows.json
git commit -m "Resolve upgrade conflict — accept upstream flows.json"
```

Then **re-apply your Init Defaults values via the Node-RED editor**
(Part A5.1 above — opens the editor, edits the constants, deploys).
Takes 2 minutes; only callsign / grid / MQTT broker / POWER_STRIP /
POWER_CH need retyping. Lat/lon derives automatically.

If you had stashed local edits in B2, you can recover them for
reference:

```bash
git stash pop                    # may report conflicts — that's OK
git diff flows.json              # see what your stash wanted to change
# Then revert with: git checkout flows.json
```

## B7. Restart + hard-refresh (1 minute)

```bash
sudo systemctl restart nodered
sleep 10
sudo journalctl -u nodered -n 30 --no-pager | grep -E "Started flows|error"
```

You should see `Started flows`. Any `error` lines are a problem —
see Troubleshooting.

In every browser/device that runs the dashboard:

- **Safari (desktop)**: hold Shift, click the reload button
- **iPhone/iPad Safari**: close all tabs, reopen `/shack`. If still
  stale: Settings → Safari → Advanced → Website Data → search your
  Pi's IP → swipe-delete the entry, re-add to home screen.
- **Chrome desktop**: `Cmd+Shift+R` (Mac) / `Ctrl+Shift+R` (Win)

You should see the new build stamp in the dashboard footer — e.g.
`v10 · 2026-06-03 ANT toggle`. That confirms the latest JS loaded.

## B8. Verify after upgrade

| Check | How |
|---|---|
| Flow loaded clean | `sudo journalctl -u nodered -n 50 \| grep -E "Started flows\|Unknown type"` — want the first, not the second. |
| Init Defaults intact | Open editor → Lightning tab → Init Defaults → confirm YOUR callsign / grid / MQTT broker are still there. |
| Dashboard shows your data | `/shack` header shows YOUR callsign, not VU2CPL. If VU2CPL, re-apply A5.3. |
| New endpoints work | If the changelog mentioned new endpoints, test with `curl -X POST http://localhost:1880/lightning/<endpoint>` from the Pi. |
| Tasmota controls work | Toggle any power button on the dashboard — should switch the corresponding Tasmota device. If not, your Tasmota topic config may have drifted (re-apply A5.4). |

---

# Part C — Hardware variations

## C1. Hardware you DON'T have

The default flow includes tabs for every piece of hardware in
VU2CPL's shack. **If you don't have one, the dashboard card just
shows "—"** everywhere — harmless.

If you'd rather **hide** the card entirely:

| Don't have | Delete from Node-RED editor | Delete from `index.js` (Vue) |
|---|---|---|
| FlexRadio | `FlexRadio` flow tab | `<FlexCard />` in App template |
| SPE amp | `SPE` + `LP-700-HID ws` tabs | `<SPECard />`, `<LP700Card />` |
| Rotor-EZ rotator | `Rotator` tab | `<RotatorCard />` |
| LP-700 / LP-500 meter | `LP-700-HID ws` tab | `<LP700Card />` |
| DX clusters | `DXCC Tracker` + `RBN Skimmer Monitor` tabs | `<DXCCCard />`, `<RBNCard />` |
| GPS NTP server | `GPS NTP (card)` tab | `<GpsNtpCard />` |
| Solar / NOAA monitor | `Solar` tab | `<SolarCard />` |

After deleting, click Deploy in the editor and save the Vue change
(no restart needed for Vue files; refresh `/shack`).

## C2. Different cluster hosts, FlexRadio model, etc.

| Change | Where |
|---|---|
| FlexRadio IP / model | `FlexRadio` tab → `flexradio-conn` config node |
| SPE amp serial path | `SPE` tab → `spe-remote` Pi-side service config; SPE FTDI may need a custom udev rule. |
| Rotor-EZ serial path | `Rotator` tab → serial-in/out node config |
| LP-700 server URL | `LP-700-HID ws` tab → websocket-client config |
| DX cluster hosts | `DXCC Tracker` tab → 4 `tcp in` nodes — change `host` field per node |
| GPS NTP topic | `GPS NTP (card)` tab → `mqtt in` node — change topic |

---

# Part D — Optional customization

## D1. Rebrand: icons, name, colors

Replace VU2CPL's logo with your callsign's:

1. Edit the SVG sources:
   ```bash
   cd ~/.node-red/projects/vu2cpl-shack/uibuilder/shack/src/
   nano icon.svg
   nano icon-maskable.svg
   ```
   Both are plain SVG — open in any text editor, replace the
   `VU2CPL` text with your callsign.

2. Regenerate the PNG raster files. Requires `rsvg-convert` and
   Python's `PIL` library on your Pi:
   ```bash
   sudo apt install -y librsvg2-bin python3-pil

   rsvg-convert -w 180 icon.svg          -o apple-touch-icon-180.png
   rsvg-convert -w  16 icon.svg          -o favicon-16.png
   rsvg-convert -w  32 icon.svg          -o favicon-32.png
   rsvg-convert -w  48 icon.svg          -o favicon-48.png
   rsvg-convert -w 192 icon-maskable.svg -o icon-192.png
   rsvg-convert -w 512 icon-maskable.svg -o icon-512.png

   python3 -c "from PIL import Image; \
       imgs=[Image.open(f'favicon-{s}.png') for s in (16,32,48)]; \
       imgs[0].save('favicon.ico', \
       sizes=[(16,16),(32,32),(48,48)], \
       append_images=imgs[1:])"
   ```

3. Bump the `?v=N` cache buster in `index.html` to force browsers
   to re-fetch.

4. Edit `manifest.json`:
   ```json
   {
     "name": "MYCALL Shack",
     "short_name": "Shack",
     ...
   }
   ```

5. On iPhone/iPad: delete the old home-screen icon, re-add fresh.

## D2. Add your own card

Adding your own Vue card to the dashboard:

1. Open `~/.node-red/projects/vu2cpl-shack/uibuilder/shack/src/index.js`.
2. Copy any existing `const Foo = { template: ..., setup() { ... } }`
   block as a starting template.
3. Register it in the `components` block of `App`.
4. Add `<FooCard />` to the App template.
5. For data flow: Node-RED side → `uibuilder.send(...)`, Vue side →
   `uibuilder.onChange('msg', ...)`. Or use HTTP endpoints +
   `fetch()` (as the Lightning / Power buttons do).

This is undocumented developer territory — read existing cards
(`LightningCard`, `PowerCard`, `FlexCard`) as examples. Comments
in `index.js` describe the patterns.

---

# Part E — Reference

## E1. What lives where (cheat sheet)

| Thing | Path on the Pi |
|---|---|
| **The repo (correct location)** | `~/.node-red/projects/vu2cpl-shack/` |
| Node-RED userDir | `~/.node-red/` |
| Node-RED settings | `~/.node-red/settings.js` (gitignored — your auth + projects config live here) |
| Node-RED palette | `~/.node-red/node_modules/` + `~/.node-red/package.json` |
| Node-RED systemd unit | `/lib/systemd/system/nodered.service` (don't edit directly) |
| Systemd drop-in for secrets | `/etc/systemd/system/nodered.service.d/secrets.conf` |
| Pi-side scripts | `/home/<user>/{rpi_agent.py, monitor.sh, power_spe_on.py, as3935_*.py}` |
| Pi-side systemd units | `/etc/systemd/system/{rpi-agent, as3935, lp700-server}.service` |
| udev rules | `/etc/udev/rules.d/{10-telepost.rules, 99-lp700.rules}` |
| Sudoers for rpi-agent | `/etc/sudoers.d/rpi-agent` |
| Cron entry (monitor.sh) | `crontab -e` as your user — `* * * * * /home/<user>/monitor.sh` |
| Mosquitto config | `/etc/mosquitto/conf.d/lan.conf` (anonymous on port 1883) |
| LP-700 server | `~/lp700-server/` (cloned from VU3ESV) |
| **Runtime data files** (auto-generated): | |
| DXCC worked seed | `~/.node-red/projects/vu2cpl-shack/nr_dxcc_seed.json` |
| DXCC blacklist | `~/.node-red/projects/vu2cpl-shack/nr_dxcc_blacklist.json` |
| cty.xml prefix cache | `~/.node-red/projects/vu2cpl-shack/nr_cty_maps.json` |
| Lightning event log | `~/.node-red/projects/vu2cpl-shack/nr_lightning_events.jsonl` |

## E2. Auth & secrets — what's safe to push

- `settings.js` is **gitignored**. Your bcrypt password hash never
  enters git history. Safe to commit and push your customized fork.
- `secrets.conf` is in `/etc/systemd/`, **not in the repo at all**.
  Never committed.
- Init Defaults values (callsign, grid, MQTT broker IP) ARE in
  `flows.json` and DO get committed. If your fork is public, those
  values are visible. If that's a concern, keep your fork private.

To generate a new bcrypt hash:
```bash
node-red admin hash-pw
# Enter chosen password. Output: $2y$08$...
```
Paste into 3 places in `~/.node-red/settings.js`:
- `adminAuth.users[0].password` (editor login)
- `httpNodeAuth.pass` (HTTP endpoint protection)
- `ui.auth.users[0].password` (D1 `/ui` dashboard)

Restart:
```bash
sudo systemctl restart nodered
```

## E3. Troubleshooting

| Symptom | Diagnosis & fix |
|---|---|
| **`/shack` shows `—` everywhere** | MQTT broker IP wrong in Init Defaults. Verify `MQTT_BROKER` matches your Pi's IP. |
| **Lightning auto-disconnect doesn't fire** | `POWER_STRIP` / `POWER_CH` in Init Defaults doesn't match your Tasmota device topic. Check Tasmota web UI → Configuration → MQTT. |
| **DXCC tab shows red status badges, no spots** | Cluster IPs unreachable from your network. Test with `nc cluster.host port` from the Pi. Most likely your firewall blocks outbound port 23 / 7300 / 7550 / 8300. |
| **Telegram alerts silent** | Empty `TELEGRAM_TOKEN` env var — intentional if not using. Otherwise check `secrets.conf` and `sudo systemctl restart nodered`. |
| **`/shack` shows VU2CPL icon after rebrand** | PWA cache. Bump `?v=N` in `index.html`. iPhone: Settings → Safari → Advanced → Website Data → search Pi IP → delete entry. |
| **Power-strip toggle clicks but state doesn't sync back** | Tasmota's MQTT Topic field doesn't match what the flow expects. Check Tasmota web UI. |
| **`/shack` 404s** | `node-red-contrib-uibuilder` not installed (`bash rebuild_pi.sh --stage 4`), or `Vue Dashboard` flow tab not deployed (open editor and click Deploy). |
| **Editor login fails** | `settings.js` `adminAuth.users[0].password` is the old hash or empty. Regenerate (see E2). |
| **HTTP endpoints return 401** | Same root cause as editor login, but `httpNodeAuth.pass` in `settings.js`. |
| **D1 `/ui` doesn't load but `/shack` does** | `ui.auth.users[0].password` is set in `settings.js` but not configured correctly. |
| **`Unknown type` errors in Node-RED journal** | Missing palette node. Run `bash rebuild_pi.sh --stage 4`. |
| **`Error: ENOENT: no such file or directory`** | A runtime data file (`nr_dxcc_seed.json`, `nr_cty_maps.json`, etc.) hasn't been created yet because the relevant flow hasn't fired. These auto-generate on first relevant event. Restart Node-RED and wait. |
| **Pi rebooted, antenna stuck OFF** | If you manually disconnected via the dashboard, that flag is **sticky** (`flow.manual_off` survives restart — by design). Click "ANTENNA OFF" button on dashboard → confirm "Reconnect antenna?" → done. |
| **Stage X of rebuild_pi.sh keeps failing** | Read the error message carefully — usually it's specific (`npm registry timeout`, `permission denied`, `repo unreachable`). Re-run with `bash rebuild_pi.sh --stage X` after fixing. Or skip with `bash rebuild_pi.sh --stage $((X+1))` if non-critical (e.g. stage 11 LP-700 server, if you don't have one). |
| **`Cmd+Shift+R` doesn't hard-refresh Safari** | Safari doesn't have that shortcut. Hold **Shift** + click the reload button instead. |

## E4. Doc map (where to look for more)

| Doc | What it's for |
|---|---|
| **FORK_GUIDE.md** (you are here) | Run this stack at YOUR station — fresh install, upgrade, customization, troubleshooting |
| **REBUILD_PI.md** | Stage-by-stage manual rebuild — verbose technical reference, deeper than this guide |
| **DEPLOY_PI.md** | Onboard ANOTHER Pi as a fleet member (telemetry + reboot only, not a full shack node) |
| **README.md** | Overview of the whole repo |
| **CLAUDE.md** | Operator-level developer reference: node IDs, gotchas, change history, VU2CPL-specific lore. Dense but indispensable when modifying flows. |
| **HANDOVER.md** | Session-to-session continuity — current state, open issues, last commit. Read when picking up after a break. |
| **SHACK_CHANGELOG.md** | Dated entries describing every substantive change. Useful when figuring out what an upgrade brings in. |

## E5. Where to ask for help

Open an issue against [`vu2cpl/vu2cpl-shack`](https://github.com/vu2cpl/vu2cpl-shack/issues)
describing:

- What you tried
- What you expected
- What actually happened (include the Node-RED journal lines if relevant:
  `sudo journalctl -u nodered -n 50 --no-pager`)

If anything in this guide isn't clear, that's a doc bug — please
say so explicitly. The guide gets better with each ham who reads it.

---

73 and happy automating.
