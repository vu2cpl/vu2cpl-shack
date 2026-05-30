# Running this shack stack at your station

This guide is for **another ham operator** who wants to run this same
shack-automation setup at their QTH — adapting it from VU2CPL's
specifics (callsign, grid, hardware roster, MQTT broker IP) to your
own.

You don't need to know git, GitHub forks, or Node-RED internals.
What you DO need: an SSH login on your Pi, your station's basic
info (callsign, grid square, antenna power switch details), and
about 90 minutes to walk through the four steps below.

---

## What you'll end up with

After you finish this guide:

- **Web dashboard at `http://<your-pi-ip>:1880/shack`** — phone /
  tablet / Mac / Windows. Installable as a home-screen app on
  iPhone & iPad.
- Lightning auto-disconnect of your antenna when storms come
  near, with operator override and bypass.
- FlexRadio / SPE amp / LP-700 meter / antenna rotator readouts
  and controls (skip whichever you don't have).
- DXCC tracker that fires Telegram alerts for new entities/bands/
  modes from real-time cluster spots.
- Solar conditions, RPi fleet monitor, network ping, GPS-NTP card.
- All behind a single username/password login.

---

## What you need before starting

- **Raspberry Pi 4B** (or newer) running Pi OS Lite 64-bit, with
  SSH access. Login is `vu2cpl` in this guide — change to whatever
  user you set up.
- **Internet** at your Pi.
- **Your callsign** and **6-character grid square**
  (e.g. `MK83TE` for Bengaluru). If you don't know your grid,
  use [maidenhead-locator.com](http://www.k7fry.com/grid/).
- **MQTT broker IP** — usually the Pi itself if you'll run
  Mosquitto there (recommended). Default `192.168.1.169`; change
  to your Pi's IP.
- **Tasmota-flashed power switch** for your antenna (and optionally
  the radio). Note its MQTT topic name (e.g. `powerstrip1` /
  `POWER5`).
- **Optional**: Club Log account + API key, Telegram bot token +
  chat ID, FlexRadio, SPE amp, LP-700 meter, rotator.

---

## The four steps

### Step 1 — Get the code (5 minutes)

On your Pi, in your home directory:

```bash
git clone https://github.com/vu2cpl/vu2cpl-shack.git
```

That gives you a folder `vu2cpl-shack` with everything in it.
You don't need to fork it on GitHub unless you plan to contribute
changes back — for personal use, the plain clone is enough.

To update later (when new features land), you'll just run:

```bash
cd ~/vu2cpl-shack
git pull
```

### Step 2 — Install Node-RED and the rest (60 minutes, one-time)

Follow [`REBUILD_PI.md`](REBUILD_PI.md) end-to-end. That document
handles: apt packages, Mosquitto MQTT broker, Node-RED itself, the
required palette (uibuilder + dashboard + flexradio + others),
file-context store, Pi-side scripts (lightning sensor daemon, RPi
agent), systemd services, udev rules, dashboard auth.

There's a `rebuild_pi.sh` script that automates most of it.

When REBUILD_PI.md is done, you should be able to open
`http://<your-pi-ip>:1880/shack` and see the dashboard load
**with VU2CPL's values in it** — your callsign in the header,
your antenna power switch, your DXCC stats etc. are NOT in there
yet. That's what Step 3 fixes.

### Step 3 — Tell it about YOUR station (30 minutes, one-time)

This is the customisation step. The good news: 90% of what you
need to change lives in **two Node-RED nodes** + **one settings
file**. Find each, edit, deploy.

Open the Node-RED editor at `http://<your-pi-ip>:1880` and log
in with the credentials you set up during REBUILD_PI Step 4
(dashboard auth).

#### 3a — Lightning + station identity

Go to the **Lightning Antenna Protector** flow tab. Find the node
labelled **`Init Defaults ✏️ EDIT HERE`** (icon: blue function
node, prominently labelled at top of tab). Double-click to open.

Edit the constants at the top of the function:

```javascript
const MQTT_BROKER   = '192.168.1.169';     // ← your Pi's IP
const CALLSIGN      = 'VU2CPL';            // ← YOUR CALLSIGN
const GRID_SQUARE   = 'MK83TE';            // ← YOUR 6-char grid

// Which Tasmota relay controls your antenna power
const POWER_STRIP   = 'powerstrip1';       // ← your Tasmota topic name
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

The lat/lon for Open-Meteo weather polling is **derived automatically**
from your grid square — no manual calculation needed.

Click **Done**, then **Deploy** (top-right).

#### 3b — DXCC tracker credentials (skip if you don't use DX clusters)

Edit `/etc/systemd/system/nodered.service.d/secrets.conf` on the
Pi:

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

Save, then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart nodered
```

In the **DXCC Tracker** flow tab, open the **`⚙️ Credentials
(edit once)`** node. Just verify the callsign is yours:

```javascript
const CL_CALLSIGN     = 'VU2CPL';     // ← YOUR callsign (no SSID)
const CL_LOGIN_SSID   = '-1';         // ← your SSID suffix
                                      //   (keep -1 unless another
                                      //    instance of you is on)
```

Click Done → Deploy.

#### 3c — Tell the dashboard your callsign

Edit `~/vu2cpl-shack/uibuilder/shack/src/index.js`. Find the
**TopBar** Vue component (search for `class="callsign"`).

```javascript
<span class="callsign">VU2CPL</span>           // ← YOUR callsign
<div class="sub">MK83TE · Bengaluru · ...</div> // ← YOUR grid · city
```

Save the file. No restart needed — uibuilder serves it live;
just refresh `/shack` in your browser.

### Step 4 — Use it

Open `http://<your-pi-ip>:1880/shack` on each device:

- **Mac Safari 17+**: File → Add to Dock → Add
- **iPad / iPhone Safari**: Share → Add to Home Screen → Add
- **Android Chrome**: ⋮ → Install app → Install
- **Windows / Linux Chrome / Edge**: address-bar install icon → Install

Each device prompts for the password once and remembers it.

That's it. You're running.

---

## Optional — hardware you DON'T have

The default flow includes tabs for every piece of hardware in
VU2CPL's shack. If you don't have one of them, the dashboard card
will just show "—" everywhere — harmless. But if you'd rather hide
the card entirely, you can:

- **Don't have a FlexRadio?** Delete the `FlexRadio` flow tab in
  the Node-RED editor + remove `<FlexCard />` from `App` template
  in `uibuilder/shack/src/index.js`.
- **Don't have an SPE amp?** Same pattern, `SPE` tab + `<SPECard />`.
- **Don't have a rotator?** `Rotator` tab + `<RotatorCard />`.
- **Don't have an LP-700?** `LP-700-HID ws` tab + `<LP700Card />`.
- **Don't use DX clusters?** `DXCC Tracker` + `RBN Skimmer Monitor`
  tabs + `<DXCCCard />` + `<RBNCard />`.
- **Don't have a GPS NTP server?** `GPS NTP (card)` tab + `<GpsNtpCard />`.

After deleting/removing, save and deploy.

---

## Optional — make the dashboard look like *your* station

By default, the home-screen icon shows VU2CPL's logo. To rebadge
for your station:

1. Edit `~/vu2cpl-shack/uibuilder/shack/src/icon.svg` and
   `icon-maskable.svg` — open in any text editor, replace `VU2CPL`
   text with your callsign.

2. Regenerate the PNG raster files (one-time, requires `rsvg-convert`
   and Python's `PIL` library):

   ```bash
   cd ~/vu2cpl-shack/uibuilder/shack/src/
   rsvg-convert -w 180 icon.svg          -o apple-touch-icon-180.png
   rsvg-convert -w  16 icon.svg          -o favicon-16.png
   rsvg-convert -w  32 icon.svg          -o favicon-32.png
   rsvg-convert -w  48 icon.svg          -o favicon-48.png
   rsvg-convert -w 192 icon-maskable.svg -o icon-192.png
   rsvg-convert -w 512 icon-maskable.svg -o icon-512.png
   python3 -c "from PIL import Image; imgs=[Image.open(f'favicon-{s}.png') for s in (16,32,48)]; imgs[0].save('favicon.ico', sizes=[(16,16),(32,32),(48,48)], append_images=imgs[1:])"
   ```

3. Bump the `?v=N` cache-buster in `index.html` to force browsers
   to re-fetch.

4. On iPad/iPhone: delete the old home-screen icon, re-add fresh.

Edit `manifest.json` so the PWA install name shows your station:

```json
{
  "name": "MYCALL Shack",
  "short_name": "Shack",
  ...
}
```

---

## Power switching — your Tasmota devices

The default flow expects these Tasmota MQTT topics:

```
stat/powerstrip1/POWER1..5
stat/powerstrip2/POWER1..5
stat/powerstrip3/POWER1..5
stat/4relayboard/POWER1..4
stat/16Amasterswitch/POWER1
```

For each of YOUR Tasmota devices:

1. Pick a topic name on your Tasmota web UI →
   Configuration → MQTT → Topic field (e.g. `kitchen-strip`,
   `shack-power`). Restart Tasmota.
2. In Node-RED, find the matching `mqtt in` nodes on the
   `All Power Strips` flow tab and change their topics to yours.
3. In the **Power Control Panel** ui_template (or `<PowerCard />`
   in Vue), edit the device list to match your hardware count.

Set the **timezone** on each device (web UI Console:
`Timezone +05:30` for India, `Timezone +00:00` for UTC, etc.) so
the daily energy counters roll over at your local midnight.

---

## Other clusters / radios / hardware

If your hardware differs from VU2CPL's exact roster, here's a
quick map of which Node-RED nodes to edit:

| Hardware | Node-RED location |
|---|---|
| FlexRadio IP / model | `FlexRadio` tab → `flexradio-conn` config node |
| SPE amp serial path | `SPE` tab → `spe-remote` Pi-side service config |
| Rotator serial path | `Rotator` tab → serial-in/out node config |
| LP-700 server URL | `LP-700-HID ws` tab → websocket-client config |
| DX clusters | `DXCC Tracker` tab → 4 `tcp in` nodes (replace hosts) |
| Telegram alerts | Empty `TELEGRAM_TOKEN` env = silent skip (Step 3b) |
| GPS NTP topic | `GPS NTP (card)` → `mqtt in shack/gpsntp/chrony` |

For per-tab deep details, the **CLAUDE.md** file in the repo has
node IDs, gotchas, and operational lore — it's the dev/operator
reference (somewhat dense; for VU2CPL-specific history).

---

## Updating later

When new features land in the repo:

```bash
cd ~/vu2cpl-shack
git pull
```

If `flows.json` changed:

```bash
ssh vu2cpl@<your-pi-ip>
cd ~/.node-red/projects/vu2cpl-shack
git pull
sudo systemctl restart nodered
```

If only Vue dashboard files changed (`uibuilder/shack/src/*.js`,
`*.css`, `*.html`), no restart needed — just refresh `/shack`
in your browser.

Your customisations in **Init Defaults** (callsign, grid, MQTT
broker) won't be overwritten by `git pull` because the values you
edited live in your local copy of the file. But if there's a
merge conflict on `flows.json`, that's a sign the upstream changed
the same lines you edited — resolve by keeping your values and
accepting upstream changes for everything else.

---

## Auth — set YOUR password, not VU2CPL's

REBUILD_PI.md Step 4's "Enable dashboard auth" sub-section walks
you through this. Critical: **generate your own bcrypt hash**.
The hash committed in this repo (if visible anywhere — it
shouldn't be, `.gitignore` excludes `settings.js`) is **VU2CPL's**.

```bash
node-red admin hash-pw
# Enter your chosen password; copy the $2y$08$... hash to all
# three places in ~/.node-red/settings.js:
#   adminAuth.users[0].password
#   httpNodeAuth.pass
#   ui.auth.users[0].password
sudo systemctl restart nodered
```

Then verify:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:1880/ui
# Expect 401 - auth working
```

Your `settings.js` is `.gitignore`d, so your password hash never
leaks even if you push your customised fork publicly.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Dashboard shows `—` everywhere | MQTT broker IP wrong in some flow nodes (Step 3a). Check `MQTT_BROKER` in Init Defaults. |
| Lightning auto-disconnect doesn't fire | `POWER_STRIP` / `POWER_CH` in Init Defaults doesn't match your Tasmota device topic. |
| DXCC tab shows status badges red, no spots | Cluster IPs unreachable from your network. Verify with `nc cluster.host port` from your Pi. |
| Telegram alerts silent | Empty `TELEGRAM_TOKEN` env var — intentional if you don't want them. Otherwise check Step 3b. |
| `/shack` shows VU2CPL icon on home-screen | PWA cache. Bump `?v=N` in `index.html`. iPhone: Safari → Settings → Advanced → Website Data → search your Pi's IP → delete. |
| Power-strip toggle clicks but state doesn't sync back | Tasmota device's MQTT Topic field doesn't match what the flow expects. |
| `/shack` 404s | `node-red-contrib-uibuilder` not installed, or `Vue Dashboard` flow tab not deployed. See REBUILD_PI.md Step 12 check #4. |

---

## Doc map (for context)

| Doc | What it's for |
|---|---|
| **FORK_GUIDE.md** (you are here) | Run this stack at YOUR station |
| **REBUILD_PI.md** | Bring up the Pi from scratch — both VU2CPL's and yours |
| **DEPLOY_PI.md** | Onboard ANOTHER Pi as a fleet member (monitoring + reboot) |
| **README.md** | Overview of the whole repo |
| **CLAUDE.md** | Deep operator/developer reference (mostly VU2CPL lore) |

---

## Where to ask for help

If something in here isn't clear, that's a doc bug — please open an
issue against [`vu2cpl/vu2cpl-shack`](https://github.com/vu2cpl/vu2cpl-shack/issues)
saying what you tried and what was confusing. The guide gets better
with each ham who reads it.

73 and happy automating.
