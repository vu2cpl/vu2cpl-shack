# Forking vu2cpl-shack for your own station

This repo is the live shack-automation stack of **VU2CPL · MK83TE ·
Bengaluru**. It runs on a Raspberry Pi 4B and controls one specific
hardware roster (FlexRadio FLEX-6600, SPE Expert 1.5 KFA, LP-700,
Rotor-EZ, 21 Tasmota outlets, AS3935 lightning sensor over an ESP32
bridge, DX cluster + DXCC tracker, RPi fleet monitor, GPS NTP).

Most of that is portable. Some of it is location-, callsign-, or
broker-specific and **must** be customised before the flow will do
anything useful at your site. This document is the customisation
runbook — the set of knobs to turn for your own station.

> **You are NOT reading this if you are Manoj rebuilding his own Pi.**
> That's [`REBUILD_PI.md`](REBUILD_PI.md) — same-Pi disaster recovery
> with all the VU2CPL-specific values already baked in.

---

## When to read this vs. REBUILD_PI

| Scenario | Doc |
|----------|-----|
| Manoj's SD card died — bring `noderedpi4` back to life identically | **REBUILD_PI.md** alone |
| You're a different operator cloning to your own station | **FORK_GUIDE.md (this)** + REBUILD_PI.md |
| You're onboarding another Pi to *Manoj's* fleet (telemetry + reboot) | **DEPLOY_PI.md** |

For Scenario 2: it's easiest to follow **REBUILD_PI.md end-to-end
first** to get a working clone of VU2CPL's setup, then come back to
this doc and walk through Stage A → Stage Z below to rebadge it for
your station. (Don't try to do customisation *during* the rebuild —
chasing two unknowns at once turns "it doesn't work" into "and I
don't know why" much faster.)

---

## Suggested working approach

1. **Fork** `github.com/vu2cpl/vu2cpl-shack` to your own GitHub account.
2. Clone your fork on the Pi (REBUILD_PI Step 5 — substitute your URL).
3. Bring the stack up by following REBUILD_PI Steps 1–13.
4. Verify the `/ui` and `/shack` dashboards load (you'll see VU2CPL's
   default values everywhere — that's expected at this stage).
5. Walk through Stages A–Z below in order. Each stage is small (one
   node or one config block) and ends with "verify it took."
6. `nrsave "fork: <stage X>"` after each change so you can bisect any
   regression.
7. Once everything is rebadged, push to your fork.

---

## Hardware compatibility — read this first

This stack assumes the following hardware. If you're missing something
in column 2, decide between **(a) delete that flow tab entirely**, or
**(b) leave it disabled** until you add the hardware.

| Subsystem | Assumed hardware | If you don't have it |
|-----------|------------------|----------------------|
| MQTT broker | Mosquitto on the Pi | Required — install Mosquitto (REBUILD_PI Step 3) |
| Lightning protection | AS3935 chip via ESP32 bridge | Disable `Lightning Antenna Protector` tab; remove `Lightning` card from `/shack` |
| Local lightning sensor | AS3935 + ESP32 ([`vu2cpl-as3935-bridge`](https://github.com/vu2cpl/vu2cpl-as3935-bridge)) OR Pi-side `as3935_mqtt.py` daemon | Same as above — AS3935 is core to the lightning chain |
| Open-Meteo weather | Internet access from the Pi | Required for CAPE-based lightning prediction; otherwise disable the OM polling inject |
| Telegram alerts | Your bot token + chat ID | Optional — leave `cfg_tg_token` empty in Init Defaults; Telegram Alert Router will skip silently |
| Power switching | Tasmota-flashed power strips (Sonoff, etc.) on MQTT | Required for any auto-disconnect to work. If you don't have any, disable the relevant flow tabs (All Power Strips, etc.) |
| HF transceiver | FlexRadio FLEX-6xxx / 7xxx series with TCP API enabled | Delete the `FlexRadio` flow tab + remove `FlexCard` from `/shack`. The rest of the stack is unaffected |
| HF amplifier | SPE Expert 1.5 KFA / 1.3K-FA / 2K-FA via FTDI serial | Delete the `SPE` flow tab + remove `SPECard` from `/shack` |
| Antenna rotator | Idiom Press Rotor-EZ (via FTDI serial) | Delete the `Rotor` flow tab + remove `RotorCard` from `/shack` |
| Power / SWR meter | Telepost LP-700 / LP-500 via USB HID | Delete the `LP-700-HID ws` flow tab + remove `LP700Card` from `/shack`. Requires [`VU3ESV/LP-700-Server`](https://github.com/VU3ESV/LP-700-Server) WebSocket gateway too |
| DX cluster + DXCC tracking | Active Club Log account + DX cluster access | Delete `DXCC Tracker` + `RBN Skimmer Monitor` flow tabs and their `/shack` cards if you don't operate DX |
| RPi fleet | Other Raspberry Pis on your LAN you want to monitor | Delete `RPi Fleet Monitor` flow tab + `RPiCard`. Or keep it and add your Pis (see DEPLOY_PI.md) |
| GPS NTP | Dedicated GPS-disciplined NTP Pi (see [`pi-gps-ntp-server`](https://github.com/vu2cpl/pi-gps-ntp-server)) | Delete `GPS NTP (card)` flow tab + `GpsNtpCard` from `/shack`. Or substitute your own NTP source's MQTT publisher |

Anything not listed (network monitor, solar conditions, power-strip
panels) is hardware-independent and will work as-is.

---

## Stage A — Network & MQTT broker

If your Pi's IP is **not** `192.168.1.169`, change it everywhere.

| Where | What |
|-------|------|
| `CLAUDE.md` | Replace every `192.168.1.169` with your Pi's IP |
| `REBUILD_PI.md` | Same |
| Node-RED editor → all `mqtt-broker` config nodes | Edit Server field to your broker IP |
| Pi-side `monitor.sh` | The `-h` arg in `mosquitto_pub` calls |
| Pi-side `power_spe_on.py` if relevant | None |

**Verify:** `mosquitto_sub -h <your-ip> -t '#' -C 5` shows traffic.

The broker has no auth in this stack (LAN-only, no exposure). If you
need auth, add `username` / `password` to every `mqtt-broker` config
node and the publisher scripts.

---

## Stage B — Lightning Antenna Protector (Init Defaults)

The Lightning tab is configured **entirely** from one node:
**`Init Defaults ✏️ EDIT HERE`** (id `ec1fd4dece8c4dc0`) on the
`Lightning Antenna Protector` flow tab. Open it in the editor.

```javascript
const MQTT_BROKER   = '192.168.1.169';   // ← your broker
const CALLSIGN      = 'VU2CPL';          // ← your callsign
const GRID_SQUARE   = 'MK83TE';          // ← your 6-char Maidenhead grid

// Antenna power switch (Tasmota MQTT device name + relay)
const POWER_STRIP   = 'powerstrip1';     // ← your Tasmota topic name
const POWER_CH      = 'POWER5';          // ← which relay (POWER1..5)

// Radio power switch (optional)
const RADIO_ENABLED = false;             // ← true if you want auto-power-off the rig too
const RADIO_LABEL   = 'Flex Radio';
const RADIO_STRIP   = '4relayboard';
const RADIO_CH      = 'POWER1';

// Thresholds
const THRESHOLD_KM   = 40;               // ← your disconnect distance
const RECONNECT_MIN  = 20;               // ← minutes-clear before reconnect
```

Grid square → lat/lon happens automatically (Maidenhead 6-char). The
distance-graded disconnect matrix (close/medium/far × cold/lit/severe)
and all 7 cfg keys at the bottom of the node are operationally tuned
for Bengaluru's monsoon storm patterns — your site may want different
values. Read the matrix description in CLAUDE.md "Lightning Antenna
Protector" → "Distance-graded disconnect" before changing them.

**Verify:** Deploy → node status badge should show
`broker:<your-ip>  <YOURCALL> <YOURGRID> → <lat>,<lon>  ant:...`.

---

## Stage C — DXCC Tracker + Telegram credentials

DXCC tab has a dedicated **`⚙️ Credentials (edit once)`** node
(id `08dcd5378a79bb18`). Most fields read from systemd environment
variables (set in `/etc/systemd/system/nodered.service.d/secrets.conf`)
so you never commit them to git. REBUILD_PI Stage 10 walks through the
secrets file creation; for the fork you just need to substitute your
own values:

```bash
sudo nano /etc/systemd/system/nodered.service.d/secrets.conf
```

```ini
[Service]
Environment="CLUBLOG_API_KEY=<your-clublog-api-key>"
Environment="CLUBLOG_EMAIL=<your-email@example.com>"
Environment="CLUBLOG_PASSWORD=<your-clublog-password>"
Environment="TELEGRAM_TOKEN=<your-telegram-bot-token>"
Environment="TELEGRAM_CHAT_ID=<your-telegram-chat-id>"
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart nodered
```

In the Credentials node, inline (not secret) values to edit:

```javascript
// callsign + login SSID for cluster connections
const CL_CALLSIGN     = 'VU2CPL';        // ← your callsign (no SSID)
const CL_LOGIN_SSID   = '-1';            // ← your SSID suffix; clusters log you in as VU2CPL-1
// (keep -1 unless another instance of you is already logged in as VU2CPL bare)

// DXCC seed + blacklist file paths — leave as-is, they auto-resolve via os.homedir()
```

**DX cluster selection.** The `DXCC Tracker` tab has 4 `tcp in` cluster
nodes wired to `Login + Parse + Dedup`. Defaults: N2WQ (`cluster.n2wq.com:8300`),
VU2OY (`vu2oy.ddns.net:7550`), VU2CPL (`vu2cpl.ddns.net:7300` — CwSkimmer-auth),
VE7CC (`ve7cc.net:23`). Replace any of these with your local / regional
clusters. The 4th-cluster slot is the easiest to swap; the first three
are wired into the alert-classify pipeline by name.

**Verify:** Deploy → DXCC tab status badge shows live spot counts. Open
`/ui` DXCC table or `/shack` DXCC card → spots arrive within seconds.

---

## Stage D — FlexRadio

Edit the `FlexRadio` flow tab's TCP connection node (Discover node
finds the radio's IP via UDP). If your radio is not on the same LAN
broadcast domain, change the IP in the `flexradio-conn` config node
to a fixed address.

**Verify:** Status badge on `flexradio` nodes shows green; slice state
appears in the `/ui` FlexRadio panel and `/shack` FlexCard.

If you don't have a FlexRadio at all: right-click the `FlexRadio` flow
tab → Delete; in `/shack/src/index.js` remove `<FlexCard />` and the
`FlexCard` component definition.

---

## Stage E — SPE amplifier

The `SPE` flow tab and the `spe-remote` service (running on the Pi)
own the FTDI serial connection to the amp. The Python service auto-
detects the port via the `/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_*`
symlinks. Your amp's FTDI chip will have a different serial number —
update the `usb-FTDI_FT232R_USB_UART_<YOURSERIAL>-if00-port0` path in
the `spe-remote` config (if it exists; otherwise the service auto-
picks the first FTDI port).

If your SPE is a 2K-FA model rather than the 1.5K-FA, the
`ws_format_state` function in flows.json detects this via
`d.model_id === '20K'` and adjusts pwrMaxMap. No change needed unless
you're on a different SPE model entirely (1K-FA etc.) — in which case
add the right power scale to that map.

**Verify:** SPE panel on `/ui` and SPECard on `/shack` show live power
readings when keyed up. Auto-ranging bar on `/shack` scales through
the `[5, 10, 25, 50, 100, 250, 500, 1k, 1.5k, 2k, 5k]` ladder.

If you don't have an SPE: delete the `SPE` flow tab; remove `SPECard`
from `/shack`.

---

## Stage F — Antenna rotator

The `Rotor` flow tab opens a serial connection to the Rotor-EZ via a
specific `/dev/serial/by-id` path (see CLAUDE.md "Hardware Map → USB
Serial Devices"). Change to your rotator's path. If you don't use
Rotor-EZ, you'll need to rewrite the `Build Rotator String` function
for your rotator's protocol.

The `/shack` RotorCard hard-codes a preset list (EU, N, US, JA, VK,
ZL, SA, W, E). Edit `src/index.js` → `RotorCard` → the `presets`
array to match your typical headings.

**Verify:** Click a preset in `/shack` → rotator moves; numeric input
+ GO works; LP/SP toggle changes the long-path vs short-path.

---

## Stage G — LP-700 power/SWR meter

Requires [`VU3ESV/LP-700-Server`](https://github.com/VU3ESV/LP-700-Server)
running as `lp700-server.service` on the Pi. The Node-RED LP-700 tab
is a WebSocket client to `ws://localhost:8089/ws`. If your gateway runs
on a different host/port, update the ws-client config node.

**Verify:** LP-700 panel shows live AVG/PEAK watts + SWR + range.

---

## Stage H — Tasmota power devices

The `All Power Strips` flow tab listens on these MQTT topics:

```
stat/powerstrip1/POWER1..5
stat/powerstrip2/POWER1..5
stat/powerstrip3/POWER1..5
stat/4relayboard/POWER1..4
stat/16Amasterswitch/POWER1
```

For each of **your** Tasmota devices:

1. Decide a topic name (e.g. `tasmota-livingroom`, `kitchen-strip`, etc.)
2. On the Tasmota web UI → Configuration → MQTT → set Topic to that name + restart
3. In Node-RED `All Power Strips` flow tab, find the MQTT-in nodes for
   `powerstrip1` etc. and change the topic to yours
4. In the `/shack` PowerCard, edit the 4-rows-of-5 layout in
   `src/index.js` → `PowerCard` to match your device count

Set `Timezone +XX:YY` on each device (REBUILD_PI Stage 11 covers this
for IST = +05:30 — substitute your local offset). The energy aggregator
on `16Amasterswitch` rolls over daily totals at local midnight, so the
TZ must be correct.

**Verify:** Toggle a plug from `/shack` PowerCard → relay clicks → state
syncs back within ~200 ms.

---

## Stage I — `/shack` Vue dashboard

`/shack` is the modern dashboard. The Vue source lives in
`uibuilder/shack/src/`:

```
index.html             ← 35 lines, references the 3 scripts
vue.global.prod.js     ← Vue 3 runtime, self-hosted (no CDN)
index.js               ← all 12 cards in one file, ~2,500 lines
index.css              ← design system + per-card styles
manifest.json          ← PWA install metadata
icon.svg, *.png        ← PWA icons (rebadge for your station!)
```

**To rebadge:**

1. **PWA icons** — `icon.svg` and `icon-maskable.svg` are hand-drawn
   SVGs with "VU2CPL / SHACK" lettering on a dark `#0d1117`
   background. Edit the SVG (any text editor or Inkscape) to swap
   the callsign. Then regenerate the PNG set:

   ```bash
   cd uibuilder/shack/src
   rsvg-convert -w 16  icon.svg -o favicon-16.png
   rsvg-convert -w 32  icon.svg -o favicon-32.png
   rsvg-convert -w 48  icon.svg -o favicon-48.png
   rsvg-convert -w 180 icon.svg -o apple-touch-icon-180.png
   rsvg-convert -w 192 icon-maskable.svg -o icon-192.png
   rsvg-convert -w 512 icon-maskable.svg -o icon-512.png
   python3 -c "from PIL import Image; imgs=[Image.open(f'favicon-{s}.png') for s in (16,32,48)]; imgs[0].save('favicon.ico', sizes=[(16,16),(32,32),(48,48)], append_images=imgs[1:])"
   ```

   Bump the `?v=N` cache-buster in `index.html` so browsers re-fetch.

2. **TopBar callsign + subtitle** — `index.js` → `TopBar` component:
   change `<span class="callsign">VU2CPL</span>` and `<div class="sub">
   MK83TE · Bengaluru · Shack Control</div>` to your values.

3. **Manifest** — `manifest.json` already says "VU2CPL Shack" / "Shack".
   Change `name` and `short_name` for your station name.

4. **Cards you don't need** — delete the component definition and the
   `<XCard />` reference in the `App` template + the import in the
   `components: {...}` registration.

**Verify:** Hit `http://<your-pi>:1880/shack` → top bar shows your
callsign, browser tab shows your icon. On iPhone/iPad: Safari Share →
Add to Home Screen → installs as your station name with your icon.

If `/shack` is blank or 404: see REBUILD_PI Step 12 check #4 for
diagnostics.

**Per-device PWA install for your users** (Mac dock, iPad/iPhone
home screen, Android app drawer, Windows/Linux app launcher) is
covered separately in **Stage O — Roll out `/shack` to your users**
below. Operator-only icon and callsign rebadging stays here.

---

## Stage J — RPi Fleet Monitor

The `RPi Fleet Monitor` tab subscribes to `rpi/<host>/*` MQTT topics
published by `monitor.sh` on each fleet Pi. Defaults in Manoj's fleet:
`noderedpi4`, `gpsntp`, `openwebrxplus`, `HassPi`.

To onboard your own Pis: follow [`DEPLOY_PI.md`](DEPLOY_PI.md) for each
Pi (copy `monitor.sh` + cron + `rpi_agent.py` + systemd). Then in the
`Route CMD: HTTP or MQTT` function node (id `a0695975fec84e2c`), edit
the `httpDevices` map to add your hostnames.

To remove the fleet monitor entirely: delete the `RPi Fleet Monitor`
flow tab and the `RPiCard` from `/shack`.

---

## Stage K — Internet & network monitor

The `Internet and network monitor` tab pings public targets
(Cloudflare, Google DNS) + your LAN gateway. Edit the `ping` config
nodes to substitute your gateway IP. Public targets are usually fine
as-is.

---

## Stage L — GPS NTP card

If you don't run a stratum-1 GPS NTP server like [`pi-gps-ntp-server`](https://github.com/vu2cpl/pi-gps-ntp-server),
delete the `GPS NTP (card)` flow tab and remove `GpsNtpCard` from
`/shack`. Or wire your own NTP source's MQTT publisher to the same
`shack/gpsntp/chrony` topic with the same payload shape (see
CLAUDE.md "Chrony / GPS Time Server card" for the payload spec).

---

## Stage M — Open-Meteo location

The `Poll Open-Meteo (5 min)` inject node on the Lightning tab fetches
weather + lightning data for fixed coordinates. The lat/lon are
**auto-derived from your `GRID_SQUARE`** in Init Defaults, so as long
as Stage B is correct, you don't need to touch the URL here.

If your station is at a coordinate that doesn't fit a clean Maidenhead
square (e.g. a portable / contest site), edit the
`Build Open-Meteo URL` function node to hardcode the lat/lon instead
of reading from flow context.

---

## Stage N — Backups & secrets

After everything is working:

1. **Push your fork** to your own GitHub account. The `.gitignore`
   excludes `nr_dxcc_seed.json`, `nr_dxcc_blacklist.json`,
   `nr_lightning_events.jsonl` — these are runtime caches /
   private and won't leak.
2. **Confirm secrets aren't in flows.json** — `grep -i 'api_key\|password\|token' flows.json`
   should return nothing meaningful (legitimate matches: `cl_apikey`
   placeholder names, `tg_token` env-var references). Real values
   live only in `/etc/systemd/system/nodered.service.d/secrets.conf`.
3. **Backup the secrets file** somewhere off the Pi.
4. Adapt `CLAUDE.md` rule #3 (DXCC PDF regen on every flow commit)
   for your fork — either keep it or drop the DXCC tab entirely.

---

## Stage O — Roll out `/shack` to your users

Once your fork is configured (A–N done), `/shack` is the dashboard
your family / co-ops / club mates actually use. They don't need to
know anything about Node-RED, MQTT, or git — they just need:

1. The dashboard URL
2. How to "install" it on their device so it looks/behaves like a
   native app, not a browser tab

This stage is the per-device roll-out checklist. Operator-only steps
(callsign / icon rebadging) are in **Stage I** above.

### Operator pre-flight — verify `/shack` actually works

Before handing the URL to users:

```bash
# On the Pi
curl -sI http://localhost:1880/shack | head -1
# Must return: HTTP/1.1 200 OK
```

```bash
# In a browser on the LAN (e.g. Mac)
# Open: http://<your-pi-ip>:1880/shack
# Verify:
#   - Your callsign appears in the TopBar (not VU2CPL)
#   - LIVE pill goes green within ~5 seconds
#   - All cards render (collapsed by default; click chevrons to expand)
#   - Browser tab icon is your rebadged favicon (not the Node-RED red dot)
```

If `/shack` returns 404: `node-red-contrib-uibuilder` isn't installed
or the `Vue Dashboard` flow tab isn't deployed. See
[`REBUILD_PI.md`](REBUILD_PI.md) Step 12 check #4.

If cards show `—` instead of live data: see Stage A above — most
likely a flow node still has the VU2CPL MQTT broker IP hard-coded.

### Hand-out — the URL + one-line description

What users need from you:

```
URL:  http://<your-pi-ip>:1880/shack
Tip:  Install as a home-screen / dock app for the best experience —
      see your platform below.
```

That's it. No login. Anyone on the LAN with the URL gets in.

> If you want LAN-only access enforced at the network layer, that's
> already the case — the Pi listens on a private RFC1918 address and
> is not exposed to the internet unless you've set up port forwarding
> (and you shouldn't, no auth).

### Install on Mac (Safari 17+ on macOS Sonoma+)

PWA appears in the dock, runs in its own window, behaves like a
native app:

1. Open `http://<your-pi-ip>:1880/shack` in **Safari**
2. **File** menu → **Add to Dock…**
3. Confirm name (defaults to "Shack" from your `manifest.json`) →
   click **Add**

**To remove later:** right-click the dock icon → **Options** →
**Remove from Dock**.

### Install on iPad / iPhone (Safari)

Runs fullscreen, no Safari chrome, respects notch / Dynamic Island:

1. Open the URL in **Safari** (not Chrome or Firefox — only Safari
   can install PWAs to the home screen on iOS)
2. Tap the **Share** button (square with up-arrow) at the bottom
3. Scroll down in the share sheet → **Add to Home Screen**
4. Confirm name → tap **Add**

The icon appears on the home screen with your rebadged station logo.

**To remove later:** tap-and-hold the icon → **Delete from Home Screen**
→ **Delete**.

### Install on Android (Chrome / Edge)

1. Open the URL in **Chrome**
2. Three-dot menu (top-right) → **Install app** (or **Add to Home
   Screen** on older builds)
3. **Install**

Result: appears in the app drawer + home screen.

### Install on Windows / Linux desktop (Chrome / Edge)

1. Open the URL in Chrome or Edge
2. Look for the **install icon** in the address bar — small monitor
   with a down-arrow on the right side of the URL field. Or use the
   three-dot menu → **Apps** → **Install this site as an app**
3. **Install**

Result: standalone app window launchable from the Start menu /
launcher.

### What users see after install

- **Live/offline pill** next to the callsign at the top
  - 🟢 **LIVE** — websocket connected, msgs flowing within the last 8s
  - 🔴 **OFFLINE** — Wi-Fi flap, Pi reboot, or Node-RED restart.
    Auto-reconnects when the link comes back; no user action needed.
  - Long-press / hover the pill for a tooltip with the last-msg age.
- **Auto-updates** — `index.html` ships with `Cache-Control:
  no-store, no-cache, must-revalidate` meta tags, so when you push
  new front-end code to your fork, users' next app open picks it up
  automatically. No reinstall needed.
- **Responsive layout** — column-masonry CSS reflows the cards to
  fit any width: 1 column on iPhone portrait, 2 on iPad portrait,
  3 on a laptop, 4 on a wide monitor. No orientation switches or
  manual zoom needed.
- **Collapsed by default** — every card opens with a one-line
  summary in its header (e.g. *Lightning · ANT ON · 0 km · CAPE 1340
  J/kg*). Tap the chevron to expand. State per card; nothing remembered
  across app restarts.

### Troubleshooting per-device install

| Symptom | Fix |
|---------|-----|
| iOS Safari "Add to Home Screen" shows the wrong icon (Node-RED red dot, or a partial favicon) | Stale Safari favicon cache. Settings → Safari → Advanced → Website Data → search your Pi's IP → swipe-delete. Reopen `/shack`, re-add to home screen. |
| Mac dock icon launches but pill stays red | The dock-icon webview cached the old HTML pre-`Cache-Control` headers. Right-click icon → Remove from Dock, reopen `/shack` in Safari, re-add. |
| iPhone shows pill OFFLINE even though Mac shows LIVE | iOS Safari's HTTP cache doesn't always honour `max-age=0`. Settings → Safari → Advanced → Website Data → search IP → swipe-delete. Then reopen. After the first post-fix open, the no-cache meta tags take effect and this won't recur. |
| Pill stays OFFLINE forever, on every device | Real Node-RED-side issue, not a client cache problem. Check `Vue Dashboard` flow tab is deployed; uibuilder is installed; `vue_*_tick_NN` injects are firing (Node-RED editor status). |
| Sunrise / sunset times overflow off-screen on iPhone portrait | Should be auto-handled by the `@media (max-width: 480px)` rule in `index.css`. If not, your fork may have an older `index.css` — `git pull` on the Pi to get the latest. |

---

## Things you can safely ignore in CLAUDE.md

CLAUDE.md is full of VU2CPL-specific operational lore (the AS3935
GPIO4-vs-GPIO17 saga, the 2026-05-13 distance-graded-disconnect
regression, the SPE WS migration history, etc.). Most of it is
"how Manoj's stack got to where it is" — useful background but **not
something you need to act on for a fork**.

What IS relevant from CLAUDE.md when forking:

- **CRITICAL RULES** section (top) — universal
- **CODING PATTERNS** section (Dashboard interactions, Telegram URL
  pattern, fwdInMessages, large function nodes) — universal
- **OPEN BUGS / PENDING TODO** — Manoj's TODO, ignore
- **GIT WORKFLOW** — adapt the `nrsave` function to your repo URL

---

## Troubleshooting forks

| Symptom | Likely cause |
|---------|--------------|
| `/ui` loads but dashboards show only `—` | MQTT broker IP wrong in some flow nodes (Stage A incomplete) |
| Lightning auto-disconnect doesn't fire | `POWER_STRIP` / `POWER_CH` in Init Defaults doesn't match your Tasmota device (Stage B) |
| DXCC tab status red, no spots | Cluster IPs unreachable from your network, or callsign rejected by clusters (Stage C: try a different cluster) |
| Telegram alerts silent | Empty `TELEGRAM_TOKEN` env (intentional — Stage C: set it if you want alerts) |
| `/shack` shows the old VU2CPL icon | PWA cache; bump `?v=N` in index.html, restart browser. On Safari macOS: Cmd+Q + relaunch (favicon cache lives in-process) |
| Power-strip toggle clicks but state doesn't sync back | Tasmota device's Topic doesn't match what flow expects (Stage H) |

For everything else: open an issue on your fork OR cross-reference
with `SHACK_CHANGELOG.md` — the changelog documents every operational
lesson VU2CPL has learned, indexed by date. Your bug is probably in
there.

---

## Contributing back

If you find a bug that's not VU2CPL-specific (e.g. a generic flow-
context race condition, a `/shack` card layout issue, a typo in
REBUILD_PI), please open a PR on `vu2cpl/vu2cpl-shack` upstream.
VU2CPL-specific fixes (your callsign, your hardware) stay in your fork.

73 and happy automating.
