# VU2CPL Shack Changelog

Fixes and changes to non-DXCC tabs of the Node-RED shack automation
(SPE amplifier, Power Control, Solar Conditions, Lightning, Rotator, etc.).

The DXCC Tracker has its own doc: see `DXCC.md` / `DXCC_Tracker_README.pdf`.
For the umbrella overview of every subsystem in this repo, see `README.md`.

---

## 2026-04-22

### SPE Amplifier — Power meter scales with selected power level

**Tab:** SPE (`648eb83c2566c7b6`)
**Node:** SPE → Dashboard Formatter (`8f7d96af1a4c24a9`)

The output-power bar was always scaled to a 1500 W full-scale regardless of
the amp's selected power level. It now auto-scales based on `col10` (L / M / H):

| Level | Full scale |
|-------|-----------|
| L (Low) | 500 W |
| M (Middle) | 1000 W |
| H (Maximum) | 1500 W |

The bar text, percentage width, and amber/red thresholds (70 % / 90 %) all
follow the new max automatically. Dashboard template (`e5b15d8e700bf002`) was
already reading `d.pwrMax` — no UI change needed.

---

### Power Control Panel — Fix stale "ON" defaults + reliable state refresh

**Tab:** All Power Strips (`b76a5310767803b4`)

Three related bugs resolved:

1. **HTML defaults lied.** Rotator, USB2, and USB3 plug tiles had
   `class="pw-plug on"` hardcoded in the template (`780b75182df31634`) — they
   showed ON on every page load until an MQTT `stat/.../POWER<n>` arrived.
   Since Tasmota only publishes `stat/.../POWER<n>` on a *state change*, the
   stale classes could persist indefinitely. All three now default to `off`.

2. **Dashboard ignored Tasmota's query responses.** `Power State → Dashboard`
   (`f8c3c072b381bd1c`) was filtering out `/RESULT` topics entirely, so
   responses to state queries (which Tasmota delivers on
   `stat/<device>/RESULT` as `{"POWER<n>":"..."}`) never reached the panel.
   The function now parses the RESULT JSON and extracts every `POWER<n>` key
   into the shared `power_states` object.

3. **Startup poll only queried POWER1.** The four `Poll <device>` function
   nodes (powerstrip1, powerstrip2, powerstrip3, 4relayboard) emitted a
   single empty-payload query to `cmnd/<device>/Power`, which Tasmota
   interprets as a POWER1 query only. They now loop over every outlet on the
   device, emitting one query per POWER<n>:

   ```js
   for (var i = 1; i <= 5; i++) {
       node.send({ topic: 'cmnd/<device>/POWER' + i, payload: '' });
   }
   ```

   Combined with fix #2, this means every 30 s (and on deploy) the dashboard
   receives a fresh state for every outlet — the "always on" bug cannot
   persist more than ~30 s.

---

### Solar Conditions — Geomagnetic K/A column indices

**Tab:** Solar (`590e889d44815afb`)
**Node:** Parse K and A (`6e22622d54f653b1`)

The daily geomagnetic indices text file from NOAA
(`services.swpc.noaa.gov/text/daily-geomagnetic-indices.txt`) has three
index groups per data row:

| Columns | Group |
|--------:|-------|
| 3       | Middle-Latitude A |
| 4–11    | Middle-Latitude 8 × K |
| 12      | High-Latitude A |
| 13–20   | High-Latitude 8 × K |
| **21**  | **Planetary A (Ap)** |
| **22–29** | **Planetary 8 × Kp (fractional)** |

The parser was reading `cols[19]` for Ap and scanning `cols[20]..cols[27]`
for Kp — that's the high-latitude K range plus the first six planetary Kp
values, off by two columns in every case. Corrected to `cols[21]` for Ap
and `cols[22]..cols[29]` for Kp. The length guard was also bumped from
`< 28` to `< 30`.

Observed effect: yesterday's real values (2026-04-21) are A = 19, K ≈ 2.00.
Before the fix the dashboard was showing A ≈ 3, K ≈ 4.00.

---

### Solar Conditions — Aggregator branch discriminators

**Tab:** Solar (`590e889d44815afb`)
**Node:** Solar State Aggregator (`d8ed9693432963df`)

The aggregator's SFI, K-Index, and A-Index branches all accepted any
numeric `msg.payload` with a `msg.label`. In practice:

- The **SFI branch** matched every K / A message and happened to survive
  only because the SFI HTTP response arrived *last* in each poll cycle.
- The **K branch** had no discriminator against A, so the A-Index message
  (second output of Parse K and A) would overwrite `st.k` with the A value.

This was invisible while the parser was producing bogus near-identical
K and A values (pre-column-fix). Once the column-index fix started
producing a correct A = 19, the K gauge began showing 19.0 with the A's
"Unsettled" label.

The three branches now discriminate by their gauge's `control.sectors`
shape:

| Metric | Discriminator |
|--------|---------------|
| SFI    | `sectors[0].val === 50` (gauge min is 50, not 0) |
| K      | `sectors[0].val === 0.0 && sectors[1].val < 15` (K's 4.5) |
| A      | `sectors[0].val === 0.0 && sectors[1].val > 10` (A's ≥ 35.5) |

---

### Rotator Auto-Off Timer — 60 s countdown reset loop

**Tab:** All Power Strips (`b76a5310767803b4`)
**Node:** Rotator Auto-Off Timer (`05f0ddeb566a90fc`)

Symptom: rotator turned on, 60 s timer counted down to 0, then reset
itself back to 60 s; physical switch stayed ON indefinitely. Cause:
the timer unconditionally restarts whenever a `stat/powerstrip1/POWER2`
= `"ON"` message arrives, and something (Tasmota echo, state-poll
response, possibly a SetOption-related republish) keeps sending
`"ON"` for an already-on outlet.

Fix: make the timer **idempotent** and add a post-OFF cooldown:

- If a timer is already running, additional `"ON"` messages are ignored
  (they do not reset the countdown).
- After the timer fires OFF (or an OFF is received), a 10 s cooldown
  begins. Any `"ON"` during that window is ignored — this breaks the
  reset loop regardless of its source.

Also fixed the status string from "Timer running — 5 min" to
"Timer running — 60 s" (it has always been 60 s in code; the label was
stale from an earlier intended value).

---

## 2026-05-01

### AS3935 Lightning Sensor — Service revived after 10-day silent outage

**Service:** `as3935.service` (systemd) → `/home/vu2cpl/as3935_mqtt.py`

The lightning sensor daemon had been **dead since 2026-04-21 09:14 IST**
and went unnoticed for 10 days because the dashboard had no liveness
indicator. Discovered when a real storm fired no MQTT events.

Root cause of the original crash: at boot, `paho-mqtt`'s `client.connect()`
called before the network was ready and threw `OSError: [Errno 101]
Network is unreachable`. systemd hit `StartLimitBurst` and gave up.
The script had no retry loop and no liveness signal, so silence looked
identical to "no nearby strikes."

#### Hardening applied to `as3935_mqtt.py`

| Change | Why |
|--------|-----|
| `mqtt_connect_with_retry()` (2 → 60 s exponential backoff) | Survives boot-time network race |
| Last Will & Testament on `lightning/as3935/status` | Broker auto-publishes `offline` if script dies |
| Startup retained publish to `lightning/as3935/status` (`event:"ready"`) | Visible in MQTT Explorer immediately |
| 30-second heartbeat to `lightning/as3935/hb` (retained, includes `uptime_s` + per-event counters) | Silence > 60 s now unambiguously means dead |
| `on_connect` / `on_disconnect` callbacks log broker state | Easier diagnosis |
| I²C self-test on startup — reads `REG_CFG0` and logs the value | Catches dead-bus cases before the IRQ loop |
| Clean SIGTERM handler — publishes `offline` + GPIO cleanup | systemd `stop` no longer leaves a stuck GPIO claim |
| `try/except` around IRQ handler body | One bad I²C read can't crash the daemon |
| Event counters (lightning / disturber / noise / irq) in heartbeat | Observable from MQTT Explorer without reading logs |

#### Antenna mode parametrization

The original script's `set_outdoor_mode()` wrote `0x0C` to `REG_CFG0`,
which actually maps to `AFE_GB = 0x06` — *less* sensitive than the
datasheet's "outdoor" value (`AFE_GB = 0x0E` → write `0x1C`). For the
current indoor antenna placement, gain should be higher still:
`AFE_GB = 0x12` → write `0x24`.

Replaced with `set_antenna_mode("indoor" | "outdoor")` controlled by a
top-of-file `ANTENNA_LOCATION` constant. Currently `"indoor"` since the
ferrite antenna is indoors. The mode is also published in the retained
status payload so the dashboard can surface it.

**Note:** an indoor AS3935 has effective range of a few km at most
(walls block the H-field) and is prone to false disturbers from local RF.
Open-Meteo CAPE is the primary detection layer until the antenna is moved
outdoors.

#### Required systemd unit override

`Environment=PYTHONUNBUFFERED=1` must be in
`/etc/systemd/system/as3935.service.d/override.conf` — without it,
`print()` output is block-buffered and never reaches `journalctl`.
This is what made the running-but-silent state indistinguishable from
"crashed."

---

### Lightning Antenna Protector — Open-Meteo: `lightning_potential` is null in IN

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)
**Nodes:** Build Open-Meteo URL (`3d61a4f561d40c70`),
Parse Open-Meteo → Strike (`593f22a507b46335`)

Symptom: dashboard's OPEN-METEO MONITOR badge stuck at "Waiting for
data…" indefinitely; auto-disconnect never fired even during real storms.

Root cause: the flow polled the `lightning_potential` parameter, which
Open-Meteo's ICON-Global model returns as **all-`null` for India**
(verified: 0/24 non-null entries for 13.065°N 77.806°E). Every poll
hit `index === null`, the parser silently returned `null`, and
nothing reached the dashboard or strike chain.

A second issue compounded it: the parser's mapping
`km = (1 − index/100) × 200` assumed `lightning_potential` was a 0–100
percentage. Open-Meteo actually returns it as J/kg (LPI, an ICON-model
quantity that typically ranges 0–25 even for severe storms). Even if
the data had been present, the formula would have mapped a 25 J/kg
severe storm to 150 km — well above any practical threshold — so
disconnection would still never trigger.

#### Fix

**Build Open-Meteo URL** now requests `cape`, `weather_code`, and
`precipitation_probability` (hourly + current weather_code). All three
have continuous coverage globally.

**Parse Open-Meteo → Strike** rewritten with two outputs:

| Decision | Synthetic km |
|----------|--------------|
| `current.weather_code ∈ {95, 96, 99}` (TS now) | 0 (overhead) |
| Hourly `weather_code ∈ {95, 96, 99}` | 0 |
| Showers (80–82) + CAPE ≥ 1000 | 20 |
| CAPE ≥ 2500 | 10 (severe) |
| CAPE ≥ 1500 | 40 (strong) |
| CAPE ≥ 800 | 100 (moderate) |
| else | calm — no strike emitted |

Output 1 → existing Parse Strike chain (only when storm-relevant).
Output 2 → reserved for Master Dashboard live status (wire pending).

CAPE is *predictive* — it catches the convective setup hours before
the storm peaks, which is what we want for a pre-emptive antenna
disconnect. weather_code 95/96/99 is *deterministic* — when the model
reports actual thunderstorm at the grid cell, force overhead.

---

### Lightning Antenna Protector — Strike source label propagation

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)
**Nodes:** Parse Strike (`26ddff0cbbfe5fc1`),
Trigger Disconnect (`d62fb0c3c40f03b7`)

Event log lines for Open-Meteo strikes were appearing as
`DISCONNECT: Blitzortung strike N km` because:

1. **Parse Strike Case 1** (object payloads from Parse Open-Meteo and
   test injects) constructed `msg.strike` without copying the upstream
   `payload.source` field. Source was lost on every object-shaped strike.

2. **Trigger Disconnect** had a fallback default of `'Blitzortung'`
   when `msg.strike.source` was missing — a leftover from when
   Blitzortung TCP was the original real-time source (Cases 2 and 3
   in Parse Strike, which parse a binary/string TCP feed and are
   currently dead code — no upstream node feeds them).

#### Fix

```js
// Parse Strike Case 1
msg.strike = { lat, lon, time, pol, region, source: d.source };  // added source

// Trigger Disconnect
const src = msg.strike && msg.strike.source ? msg.strike.source : 'unknown';
```

Cases 2/3 left intact — if Blitzortung TCP is wired in later, set
`source: 'Blitzortung'` there at the same time.

Verified: log now reads `DISCONNECT: Open-Meteo strike 0 km`.

---

### Lightning Antenna Protector — Dashboard refresh persistence

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)
**Nodes:** Strike → Dashboard (`51367d456e71fb3e`),
Master Dashboard (`557083037f168b22`),
Refresh Stats (`61dca3d98a0e4c28`),
Clear map every 30 min (`55f94d9dde0dc893`),
new node Strikes Replay,
new node Clear All

Symptom: refreshing the dashboard browser tab wiped the **event log**
and **strike map markers** until the next event arrived. Both data sets
were held only in dashboard-local JS variables (`var strikes=[]` and the
`logLines` innerHTML), with no server-side persistence or replay path.

#### Fix — persist on the flow side, replay on the existing 30 s tick

1. **Strike → Dashboard** now appends each emitted strike to a flow-context
   array (`flow.strikes`), capped at 800 entries (FIFO). The `Format Log`
   node was already persisting log lines to `flow.event_log`.

2. **New `Strikes Replay` function node** — reads `flow.strikes` and
   emits `{type:'strikes_replay', list:[...]}` to Master Dashboard.

3. **`Refresh Stats`** (the existing 30 s ticker) now also fans out to:
   - `Log → Dashboard` (re-emits cached event log)
   - `Strikes Replay` (re-emits cached map markers)

4. **Master Dashboard** picks up a new message type:
   ```js
   if (d.type === 'strikes_replay') {
       strikeLayer.clearLayers();
       strikes = [];
       d.list.forEach(s => {
           strikes.push(s);
           L.circleMarker([s.lat, s.lon], {
               radius: 5, color: s.color, fillColor: s.color,
               fillOpacity: 0.9, weight: 1
           }).addTo(strikeLayer);
       });
       document.getElementById('lzCnt').textContent = 'Strikes: ' + strikes.length;
       return;
   }
   ```

5. **New `Clear All` function** sits between the 30-min clear-map inject
   and Master Dashboard:
   ```js
   flow.set('strikes', []);
   flow.set('event_log', []);
   return { payload: { type: 'clear' } };
   ```
   Clears both the server cache and the dashboard simultaneously, so the
   next replay tick doesn't re-paint old strikes onto a freshly cleared map.

#### Behavior after fix

| Action | Result |
|--------|--------|
| Page refresh | Log + strike markers re-appear within 30 s |
| New strike | Immediate update; also persisted to `flow.strikes` |
| 30-min auto-clear | Map cleared on dashboard *and* server cache |
| Node-RED restart | Flow context lost (default). Add `flow.context.persistent=true` for cross-restart durability — separate change. |

---

## 2026-05-06

### AS3935 — IRQ pin was GPIO17 in software, GPIO4 in hardware

**Script:** `as3935_mqtt.py`
**Helper:** `as3935_tune.py` (new)

Symptom after the May 1 revival: heartbeat counters stayed at
`{lightning:0, disturber:0, noise:0, irq:0}` indefinitely. MQTT, I²C,
and `status: "ready"` all worked, but no IRQ events ever fired.

#### Root cause

The original script declared `IRQ_PIN = 17`, but the AS3935 board's
INT line was physically wired to **GPIO4** (Pi physical pin 7). Since
the chip's I²C path was healthy, every diagnostic short of an
end-to-end IRQ test passed. The mismatch had been there since first
deploy; it was hidden because the chip-self-test only exercised I²C.

#### How it was found

A two-step diagnostic:

1. **Pull-test on GPIO17** — with the as3935 service stopped, sampled
   GPIO17 with `PUD_DOWN` / `PUD_OFF` / `PUD_UP`. Pin tracked the pull
   setting → genuine floating input → not connected to anything.
2. **SRCO scan** — set `DISP_SRCO=1` in chip register `0x08[6]` to
   route the chip's internal RC oscillator onto whatever pin its INT
   line is bonded to. Polled every accessible Pi GPIO (4, 5, 6, ...,
   27) for transitions over 200 ms. **GPIO4 showed 12,162 transitions;
   every other pin showed 0.** Conclusive.

`IRQ_PIN = 4` change applied. Heartbeat counters started incrementing
on the next NF=0 test (see below).

---

### AS3935 — LC tank tuning to 500 kHz

**Helper:** `as3935_tune.py` (new)

The AS3935 has 16 internal tuning capacitor settings (0–15, ~8 pF
per step) at register `0x08[3:0]`. The script wasn't using any of
them — it relied on whatever stray capacitance the antenna+wiring
happened to give. For accurate sferic detection, the tank should
resonate at 500 kHz ± 3.5 %.

#### `as3935_tune.py`

New helper that:

1. Configures `LCO_FDIV = 3` (÷128 divider — slow enough for Python
   event-detection to count edges reliably; ÷16 at ~31 kHz overruns
   the user-space callback)
2. Sweeps `TUN_CAP` 0..15, samples 2 s of edges per setting,
   calculates frequency = `edges × 128 / 2 s`
3. Reports the table + recommends the cap value closest to 500 kHz
4. Flags out-of-spec results (>±3.5 %) with diagnostic hints

Must be run with `as3935.service` stopped (otherwise the daemon
holds GPIO4) and the antenna in its **final mounting position** —
moving the antenna afterwards changes stray capacitance and
invalidates the tuning.

#### Result for current installation

| TUN_CAP | pF | Hz | err % |
|--------:|---:|---:|------:|
| 0 | 0 | 516,480 | +3.30 |
| 9 | 72 | 501,504 | +0.30 |
| **10** | **80** | **499,904** | **−0.02** |
| 11 | 88 | 498,560 | −0.29 |
| 15 | 120 | 493,056 | −1.39 |

All 16 cap settings happened to be within spec (typical of a clean
antenna circuit); `TUN_CAP=10` lands at −0.02 % err. Baked into the
script as `TUN_CAP = 10`.

---

### AS3935 — Add `CALIB_RCO`, INT flush, retained-status enrichment

**Script:** `as3935_mqtt.py`

Three additions to the chip-init sequence in the daemon, all chasing
the same goal of making "is the chip happy?" answerable from MQTT
without journal grep:

1. **`CALIB_RCO` at every startup** — the AS3935 has internal TRCO
   and SRCO oscillators that benefit from a one-time post-power-on
   calibration. The original script never called it; some chips
   work without, but timing-sensitive code paths can misbehave.
   Added: write `0x96` to register `0x3D`, wait 5 ms, verify
   `CALIB_DONE` (bit 7) set and `CALIB_NOK` (bit 6) clear in both
   `0x3A` (TRCO) and `0x3B` (SRCO). Result logged + published.
2. **Pending-INT flush after configuration writes** — register
   writes during init can transiently spike the IRQ line. Reading
   `0x03` (INT) clears it. Without this flush, the first real event
   sometimes arrived as a no-op rising edge that the `add_event_detect`
   callback then ignored because INT bits read 0.
3. **Retained `lightning/as3935/status` payload now includes**
   `tun_cap`, `irq_pin`, `calib_trco`, `calib_srco`. Status is
   re-published *after* calibration completes so the retained
   message reflects the actual result (the `on_connect` callback
   fires before init finishes).

#### Final init log

```
[init] AS3935 CFG0=0x24 (i2c bus 1 addr 0x03)
[mqtt] connected to 192.168.1.169:1883
[init] AFE_GB set for indoor antenna (CFG0=0x24)
[init] TUN_CAP set to 10 (80 pF)
[init] CALIB_RCO  TRCO=OK (0xA3)  SRCO=OK (0xA5)
[init] Cleared pending INT: 0x0
AS3935 ready — interrupt mode on GPIO4, noise_floor=4, antenna=indoor, tun_cap=10
```

#### Field verification

During the May 1 storm window (NF=0 momentarily), the chip caught
**209 noise events** in roughly 30 s, then went silent as the storm
moved off — the expected behaviour for an indoor narrow-band
500 kHz antenna. Subsequent tests with NF=2/NF=4 in clear conditions
remained at 0 events: not a bug, just no nearby sferics for the
selectively-tuned tank to resonate with. Until the antenna is moved
outdoors, AS3935 is a confirmation-only secondary; Open-Meteo CAPE
is the primary detection layer.

---

### Lightning Antenna Protector — AS3935 dashboard liveness panel

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)
**Nodes added:** AS3935 Status (mqtt in), AS3935 Heartbeat (mqtt in),
Format AS3935 State (function), Replay AS3935 State (function)
**Node modified:** Master Dashboard (`557083037f168b22`) — three handler
inserts inside `scope.$watch('msg', …)`

Symptom: even with the AS3935 daemon healthy and publishing
`lightning/as3935/status` (retained, on connect) and
`lightning/as3935/hb` (retained, every 30 s), the dashboard's AS3935
panel header was permanently stuck at the static placeholder
"Waiting…" because nothing in Node-RED forwarded those topics into
Master Dashboard, and the panel only updated on event-driven
`as3935_status` messages (which only fire when the chip detects
something — never indoors with a 500 kHz selective antenna).

#### Fix — surface daemon liveness in the panel header

1. **Two new `mqtt in` nodes** subscribe to
   `lightning/as3935/status` and `lightning/as3935/hb`, datatype JSON,
   feeding a single `Format AS3935 State` function node.
2. **`Format AS3935 State`** caches each payload in flow context
   (`as3935_status`, `as3935_hb`) for refresh-replay and forwards
   typed payloads `{type: 'as3935_ready', …}` and
   `{type: 'as3935_hb', …}` to Master Dashboard.
3. **`Replay AS3935 State`** (new, fed by the existing 30 s
   `Refresh Stats` ticker) re-emits cached `flow.as3935_status`
   and `flow.as3935_hb` so a refreshed dashboard tab repopulates
   within 30 s — same pattern as the strike-replay fix from May 1.
4. **Master Dashboard** gained two new message handlers and a
   guard line on the existing `as3935_status` handler:
   - `as3935_ready` → sets the status LED green/amber/red based on
     calibration (TRCO + SRCO) and `event` field, writes
     `✓ READY · NF=4 · TUN=10` (or `⚠ CALIB?` / `OFFLINE`) to the
     header right-side text, and caches the last ready snapshot
     in `window._as3935Ready` for the heartbeat handler to render.
   - `as3935_hb` → updates the header text every 30 s with current
     uptime + IRQ count: `✓ READY · NF=4 · up 14m · irq=0`.
   - The existing `as3935_status` handler (disturber/noise) now
     sets `window._as3935EvtActive = true` for 60 s so a fresh event
     display isn't immediately overwritten by the next heartbeat;
     after the timeout it auto-reverts to ready/hb display.

#### Resulting panel states

| Daemon state | Header text | LED |
|--------------|-------------|-----|
| Up, calib OK, idle | `✓ READY · NF=4 · up 14m · irq=0` | 🟢 green |
| Up, calib failed | `⚠ CALIB? · NF=4 · TUN=10` | 🟡 amber |
| Offline (LWT) | `OFFLINE` | 🔴 red |
| Disturber/noise event (60 s display) | `⚠ Disturber 23:18:01` | 🟡 amber |
| Lightning strike | `⚡ N km (energy=…)` | red/amber/green by km |
| Page refresh while idle | re-populates within 30 s | 🟢 green |

#### Layout cleanup

While editing the dashboard template, the `<!-- Event Log -->` block
was moved to sit immediately above `<!-- Map -->`. The log is more
useful adjacent to the operator's eye-line for the lightning panel
than buried at the bottom.

---

## 2026-05-08

### Lightning Detect — Leaflet map removed

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)
**Node:** Master Dashboard (`557083037f168b22`)

The map was dead weight. Both active strike sources only know
*distance*, not direction:

- **Open-Meteo** queries CAPE/`weather_code` at the home grid point,
  so `Parse Open-Meteo → Strike` always emits with `lat=home_lat`,
  `lon=home_lon`.
- **AS3935** chip provides a distance estimate; no azimuth.

Every strike circle therefore stacked on top of the green home marker
and was invisible. The Leaflet map was originally designed for a
Blitzortung TCP feed (real lat/lon for every strike worldwide), but
that integration was never wired up.

#### What was deleted from the ui_template

- `<div id="leafletMap">` block + the legend bar / `lzCnt` counter
- Leaflet 1.9.4 CSS + JS CDN imports
- CSS rules: `#mapBox`, `#lzWrap`, `.lz-bar`, `.lz-d`, `.lz-home-tip`
- JS state: `lmap`, `homeMarker`, `thrCircle`, `strikeLayer`, the
  `strikes` array + `MAX=800` cap
- `initMap()` function (Leaflet init, tile layer, threshold ring,
  home marker, strike layer group)
- `setTimeout(initMap, 400)` boot call + the `resize` listener
- `strikeLayer` / `lzCnt` manipulation in 4 handlers: `strike`,
  AS3935 `as3935`, `clear`, `strikes_replay`
- The `thrCircle.setRadius()` follow-up in the threshold-update path

Template trimmed from 1,047 lines → 943 lines.

The payload `lat` and `lon` fields in `Strike → Dashboard` are
intentionally retained — harmless dead data today, but they let
Blitzortung be wired in without re-touching that function (HANDOVER
follow-up #7).

---

### Lightning Detect — Nearest Strike gauge persists across page refresh

**Nodes:** `Strike → Dashboard` (`51367d456e71fb3e`),
`Replay on lightning tab` (`f1c57672ba7c0ec1`),
Master Dashboard (`557083037f168b22`),
`clear all` (`61516f75d2343aae`)

#### Symptom

The half-circle "Nearest Strike" gauge updated correctly when a strike
arrived live, but on every dashboard reload it reverted to the boot
value (200 km) and stayed there until the next live strike. The
existing 30 s replay tick (which had restored the strike map and
event log since 05-01) didn't touch the gauge.

#### Why

`Strike → Dashboard` was pushing only `{lat, lon, color, ts}` into
`flow.strikes` — no `km` field — so even if the replay path had been
wired to the gauge, there was nothing to feed it. And the replay
emitter (`Replay on lightning tab`) was producing
`{type:'strikes_replay', list}` for the map only; no `lastKm`. The
boot script also painted `drawGauge(200)` immediately, overwriting
the `—` placeholder before any data arrived.

#### Fix

With the map gone (above), the cache no longer needs a list at all.
Simplified to a single value:

- `Strike → Dashboard`: replaced the array push with
  `flow.set('last_strike_km', km)`.
- `Replay on lightning tab`: now reads `flow.get('last_strike_km')`
  and emits `{type:'strikes_replay', lastKm:N}` (or returns `null`
  when there is nothing to replay).
- Master Dashboard: `strikes_replay` handler reduced to
  `if(typeof d.lastKm === 'number') drawGauge(Math.min(d.lastKm,200));`.
  Boot-time `drawGauge(200)` removed — gauge now starts at "—" until
  first strike or replay.
- `clear all`: clears `last_strike_km` (and the legacy `strikes` key,
  in case anything still reads it).

Verified: trigger synthetic strike → gauge updates → page refresh →
gauge redraws to that km within the next 30 s tick. With no cached
strike, gauge stays at "—".

---

### Lightning Detect — moved to Shack tab + bypass switch + last-activity recap

**Tab moved:** Lightning Detect dashboard tab (`dd11372f9c492be8`) — deleted.
**New group:** `vu2cpl_grp_lightning` "Lightning Protection" on the Shack
tab (`vu2cpl_ui_tab_shack`), width 12, order 9.

The lightning UI is no longer a separate dashboard tab — it lives at the
bottom of the main Shack tab. The Master Dashboard ui_template
(`557083037f168b22`) was relocated to the new group and trimmed:

- Internal header card (`#hdr` with callsign + clock) removed — Shack tab's
  existing Header (`eee1a8b8552aa21f`) provides clocks + weather.
- Weather card removed — same reason.
- The wire from `Parse Weather → Header` output 2 → Master Dashboard is no
  longer needed; weather flows only to the existing Header template now.

#### Bypass switch

A new vertical `BYPASS` button lives in the switchBox between the ANTENNA
and RADIO controls. Off = grey. On = amber with a live `MM:SS` countdown
starting at `120:00`. Auto-expires after 2 hours; can be deactivated
manually at any time.

While bypass is active:

- A yellow banner above the alert reads `🔕 BYPASS ACTIVE — strikes will
  alert & log only · no auto-disconnect · expires in MM:SS`.
- Strikes still fire the alert banner (in amber, with text `STRIKE N km —
  BYPASS · alert only`) but **Trigger Disconnect** (`d62fb0c3c40f03b7`)
  early-outs without publishing MQTT off, without flipping
  `flow.antenna_off`, and without starting the reconnect timer.
- The dashboard ANTENNA + RADIO switches stay green ON.
- Activating bypass also force-reconnects (cancels any pending Reconnect
  Timer + sends an ON command to ant + radio) — designed for "I'm on the
  air, the storm is far enough away, don't drop me".

**State variables:** `flow.bypass_active` (bool), `flow.bypass_expires_at`
(ms timestamp). Init Defaults (`ec1fd4dece8c4dc0`) clears both on every
deploy/launch — bypass never survives a Node-RED restart, by design.

**Server side, three new nodes** (Lightning Antenna Protector tab):

- `POST /lightning/bypass` http-in — receives `{action:'on'|'off'}`
- `Bypass Handler` function (3 outputs):
  1. → Master Dashboard — emits `{type:'bypass_state', active, expiresAt}`
     plus a log line
  2. → Reconnect Timer — `{payload:'cancel'}` to kill any pending timer
  3. → Execute Reconnect — force ant + radio ON immediately on activation
- `200 OK` http response (parallel wire from http-in for immediate ack)

The `Replay on lightning tab` function (`f1c57672ba7c0ec1`) now emits
`bypass_state` on every Refresh Stats tick (30 s), so the banner +
countdown survive page refresh. Includes a server-side expiry safety net
in case the in-process `setTimeout` is somehow lost.

#### Reconnect buttons relabelled

The two ↺ icons next to ANTENNA and RADIO were tiny 36×36 squares with
no text. Now they stretch to match the switch row height with `↺
RECONNECT` text and a 110 px minimum width — much easier to spot.

#### Last-activity recap (replaces auto-clear)

Old behaviour: 30 s after every alert, the banner displayed
`✔ No recent activity` — misleading, since plenty of activity had
just happened. New behaviour:

- On boot, before any alert: `⏱ Awaiting first event` (muted).
- During an alert: full colour (red / amber / green / yellow-bypass).
- 30 s after the alert: banner transitions to muted recap form
  `⏱ Last: STRIKE 12 km — ANTENNA + FlexRadio OFF · 4m ago`.
- The `Nm ago` text auto-refreshes every 30 s. Hours roll into
  `2h 17m ago`, days into `1d ago`.

Two `window.lastAlert` tracking lines + a `setInterval` driver in the
ui_template; no flow node changes required.

#### Strike → Dashboard simplification

Removed the `flow.set('last_strike_km', km)` line — the gauge that
consumed it was already gone in `bf1b941`, so the write was dead.

#### Verified end-to-end

- Bypass-OFF + TEST inject (6 km strike) → red alert + ant/radio
  → OFF + reconnect timer starts. ✓
- Bypass-OFF + Open-Meteo poll (CAPE → synthetic 0–20 km strike) →
  same as TEST. ✓
- Bypass-ON + TEST inject → amber alert "BYPASS · alert only", switches
  stay green, no MQTT publish. ✓
- Bypass-ON + Open-Meteo poll → same as bypass-ON TEST (verified
  during a moderate-CAPE day where polls fired every 5 min and TD's
  status badge stayed `BYPASS · Open-Meteo Nkm — disconnect skipped`
  for the full 2 h). ✓
- Page refresh during bypass → banner + button + countdown all replay
  within 30 s via Refresh Stats. ✓

---

## 2026-05-09

### LP-700 — switched from direct USB-HID to lp700-server WebSocket gateway

**Tab:** LP-700-HID ws (`18fb42443172f33c`) — renamed from `LP-700-HID`,
trimmed from 25 nodes to 18.

VU3ESV's [LP-700-Server](https://github.com/VU3ESV/LP-700-Server) is now
running as `lp700-server.service` on the Pi at `ws://192.168.1.169:8089/ws`.
Pure-Go single binary; owns `/dev/hidraw*`; multi-client WebSocket fan-out.

#### Why migrate

`@gdziuba/node-red-usbhid` only allows one process to hold the LP-700's HID
handle at a time, which would block any other consumer (browser, phone,
the planned Mac SwiftUI app). The Go gateway moves ownership to a
dedicated service; Node-RED becomes one of N clients on the bus, same
as everything else.

Deployment was already done — the user installed `lp700-server` on the Pi
and confirmed `/healthz` before the Node-RED migration. This entry covers
only the Node-RED side.

#### What was deleted from the LP-700 tab

11 nodes, all direct-HID plumbing:

- `getHIDdevices`, `HIDdevice (HID-LP)` — HID node config + worker
- `Poll Meter Values`, `LP Dice and Slice` — poll trigger + binary parser
- `inject Poll Devices`, `inject Kickstart`, `trigger` — startup machinery
- `Raw Buffer`, `Errors` — debug nodes
- `CH cmd`, `RNG cmd` — HID-buffer button payloads (b[1]=56 / b[1]=57)

#### What was added (imported from `examples/node-red/lp700-websocket-flow.json`)

13 nodes from VU3ESV's example flow, all namespaced `lp7…` to avoid ID
collisions:

- `ws://lp700-server/ws` — websocket-in (URL `ws://192.168.1.169:8089/ws`,
  `wholemsg=false` so payload arrives as message). One websocket-client
  config (`lp7wsclient00001`).
- `ws://lp700-server/ws` — websocket-out (same client config, send side)
- `Parse frame` — JSON decoder; routes telemetry to output 1, heartbeat
  to output 2, ack to output 3
- `Reshape (KD4Z-compatible)` — maps the gateway's verbose snapshot to
  the flat `power_avg / power_peak / swr / scale / mode / channel /
  range` keys that the existing `LP State Aggregator` (and KD4Z's
  upstream nodes) expect. Zero changes downstream.
- `Connection state` — exposes link status as a status badge
- `ack` debug — shows server replies to control verbs (`{ok:true}` or
  `control disabled` etc.)
- 7 `inject` nodes labelled with each verb (peak/channel/range/alarm/
  mode/setup/freeze) — kept for canvas-side testing; deletable later
- 2 comment nodes labelling the inbound/outbound halves of the gateway

#### What was kept and rewired

- `LP State Aggregator` — function body unchanged; now fed by `Reshape`
  output (was `LP Dice and Slice` output)
- `LP-700 Panel` — ui_template unchanged
- `LP Button Router` — function body rewritten. Old version produced
  HID buffers (`Buffer.alloc(64)` with `b[1]=56` for channel, `b[1]=57`
  for range). New version emits JSON command frames:

  ```js
  if (msg.topic === 'lp700_ch')
    return { payload: JSON.stringify({type:'command', id:'…', action:'channel_step'}) };
  if (msg.topic === 'lp700_rng')
    return { payload: JSON.stringify({type:'command', id:'…', action:'range_step'}) };
  ```

  Wired directly into the websocket-out node (no link-in/out indirection
  since the gateway and dashboard live on the same tab).

#### Configuration gotcha

First import attempt produced a fake-green connection — the imported
`websocket-client` config had a stale client ID that didn't match the
URL after editing. Resolved by deleting the imported config and creating
a fresh one pointed at `ws://192.168.1.169:8089/ws`. Telemetry flowed
within 2 s of redeploy.

#### Deps that became optional

- npm: `@gdziuba/node-red-usbhid 1.0.3` — still installed but no longer
  used by any flow. Keep for now; uninstall after a week of stable WS
  operation.
- apt: `libudev-dev`, `librtlsdr-dev`, `libusb-1.0-0-dev` — only needed
  to *build* the HID node. Same retention guidance.

#### Verified

- Telemetry frames arriving at ~25 Hz (matches LP-700 LCD update cadence)
- Power/SWR/channel/range labels all live on the dashboard
- CH and RNG buttons step the meter; `ack` debug shows `{ok:true}`
- Service status: `systemctl status lp700-server` clean; no Node-RED HID
  errors after restart

#### Post-deploy fix (08c907f)

After the migration deployed, the dashboard panel was stuck displaying
stale `flow.lpState` values (AVG/PEAK 14 W, SWR 1.25 — the last numbers
the old `LP Dice and Slice` had cached before the migration). Telemetry
was flowing fine through the gateway → Reshape pipeline; the bug was
that **`LP State Aggregator` couldn't see the new shape**.

KD4Z's `LP Dice and Slice` returned `{power_avg, power_peak, swr, …}`
at the **top level of msg**. The aggregator was hand-written to read
`msg.power_avg` directly. VU3ESV's `Reshape (KD4Z-compatible)` puts
those same keys on **`msg.payload`** (per his README, matching how
KD4Z's downstream nodes consume them). So `msg.power_avg` was always
`undefined`, every conditional in the aggregator was false, and
`flow.lpState` never updated — the panel kept emitting whatever
values were in flow context at deploy time.

Fix: aggregator function body now reads from `msg.payload` first,
falling back to the top of `msg` if payload is absent. Backward-
compatible with the legacy KD4Z shape.

```js
const d = (msg.payload && typeof msg.payload === 'object') ? msg.payload : msg;
// …then read d.power_avg, d.power_peak, d.swr, etc.
```

Lesson for future migrations on this flow: when swapping a parser, audit
every consumer that reads from `msg` directly (not `msg.payload`) — the
ui_template and the aggregator can both quietly drift out of sync with
the new payload shape.

---

### Pi-side scripts — check in `rpi_agent.py` + `monitor.sh` + systemd unit

Discovered during a CLAUDE.md audit that the "RPi Fleet Monitor" docs
described `rpi_agent.py` as both the HTTP reboot/shutdown handler AND
the MQTT telemetry publisher. In reality the script is HTTP-only —
telemetry comes from a separate shell script (`monitor.sh`) running
once a minute via the `vu2cpl` user crontab. Both scripts existed
only on the Pis themselves, not in this repo. If a Pi ever needed
re-imaging the operational glue would have been lost.

#### Files added (root level)

- **`rpi_agent.py`** — 21-line stdlib-only `BaseHTTPRequestHandler`
  bound to `:7799`. Two routes: `POST /reboot` and `POST /shutdown`,
  each shells out to `sudo reboot` / `sudo shutdown -h now`. Returns
  `{"status": "rebooting"}` JSON 200 then forks the syscall.
- **`monitor.sh`** — bash, executable. Reads CPU (`top -bn1`), mem
  (`free`), temp (`/sys/class/thermal/thermal_zone0`), disk (`df /`),
  uptime (`uptime -p` with `/proc/uptime` fallback), IP (`hostname -I`
  first non-blank). Publishes each as a separate MQTT topic
  `rpi/<hostname>/{cpu,mem,temp,disk,uptime,ip,status}` to broker
  `192.168.1.169` via `mosquitto_pub`.
- **`rpi-agent.service`** — systemd unit. Runs as user `vu2cpl`,
  `Restart=always`, `After=network.target`. Standard install path
  `/etc/systemd/system/rpi-agent.service`.

#### CLAUDE.md changes

- Replaced the 7-line "RPi Fleet Monitor" subsection with a split
  "HTTP control agent" + "Telemetry publisher" + "Home Assistant Pi
  (special case)" structure. Each agent gets explicit per-Pi install
  commands (cp, daemon-reload, enable --now, sudoers, crontab line).
- Backup section: extended `tar -czf` glob to include the not-yet-
  checked-in scripts (`fetch_clublog.sh`, `enable_file_context.sh`,
  `power_spe_on.py`) flagged with HANDOVER follow-up reference.
- Added a "Pi-side scripts already in this repo" table mapping each
  repo file to its canonical deployment path under `/home/vu2cpl/`.

#### Sudoers entry confirmed

```
vu2cpl ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown
```

documented at `/etc/sudoers.d/rpi-agent` in the install commands.

---

### Pi-side scripts — `power_spe_on.py` checked in, `fetch_clublog.sh` retired

Follow-up to the earlier "Pi-side scripts" entry above.

- **`power_spe_on.py`** added to the repo. Tiny FTDI DTR/RTS toggling
  helper used to soft-power the SPE Expert 1.5 KFA. Already referenced
  in CLAUDE.md ("Power-on requires external Python: `python3
  ~/power_spe_on.py`") but never checked in. Now in repo root with the
  rest.
- **`enable_file_context.sh`** was discovered to already be tracked
  in the repo — the earlier "not yet checked into repo" annotation in
  CLAUDE.md was wrong. Annotation removed.
- **`fetch_clublog.sh`** has been deleted from the Pi entirely. The
  output file `nr_dxcc_live.json` it produced is referenced by zero
  nodes in `flows.json` (verified by full-flow grep). Live DXCC fetch
  happens in-flow via `Build Club Log API Request` →
  `Fetch All Modes + Parse` → writes to `nr_dxcc_seed.json`. The
  shell script and its output were a vestige of an older workflow.
  Removed: `~/fetch_clublog.sh`, `~/bin/`, the orphaned
  `nr_dxcc_live.json`. Cron entry checked and absent. Club Log
  password + API key rotated since they had been pasted in plaintext
  during the audit.

CLAUDE.md updates:
- "Pi-side scripts already in this repo" table extended to include
  `power_spe_on.py` and `enable_file_context.sh`.
- BACKUP section's tar glob trimmed: `fetch_clublog.sh` and
  `enable_file_context.sh` no longer listed (one's deleted, one's now
  in repo). The `power_spe_on.py` line drops the "not yet checked
  into repo" annotation.

HANDOVER follow-up #9 closed (the deferred Pi-side script migration).

---

### `DEPLOY_PI.md` — full Pi onboarding runbook

Drafted while preparing to deploy the agent + telemetry to the two
remaining Pis (and eventually the HA Pi). The CLAUDE.md "RPi Fleet
Monitor" subsection has the right copy-paste blocks but lacks
verification, troubleshooting, and the special-cases / removal flows.

`DEPLOY_PI.md` covers the full per-Pi lifecycle:
1. Prerequisites (SSH, hostname uniqueness, broker reachability)
2. `scp` the three files from the Mac repo
3. Install at canonical paths with the `sudo cp + chown` ownership
   gotcha (the 2026-05-07 quirk) called out
4. mosquitto-clients install + smoke-test telemetry with
   `mosquitto_sub`
5. Idempotent crontab append (`grep -v 'monitor.sh'` first)
6. `/etc/sudoers.d/rpi-agent` with `visudo -c` syntax check
7. `systemctl enable --now rpi-agent` + `curl /probe` smoke-test
8. Add hostname to `httpDevices` in Node-RED → deploy → `nrsave`
9. Dashboard verification

Plus: HA Pi special case (HA-side automation, not script-based),
troubleshooting table (8 common failure modes), and a clean
decommission flow.

CLAUDE.md gets a one-line cross-reference at the top of the RPi
Fleet Monitor section pointing to the new doc.

---

### Pi GPS NTP Server — new standalone repo, stratum 1 in service

Standalone repo: [vu2cpl/pi-gps-ntp-server](https://github.com/vu2cpl/pi-gps-ntp-server)

The shack now has a dedicated GPS-disciplined NTP server. A previously
unused Raspberry Pi 3B was repurposed as `gpsntp.local` (192.168.1.158)
running stratum-1 NTP for the LAN.

#### Pivot from the original ESP32 plan

The project directory was originally `~/projects/ESP32 GPS NTP/` and
scoped as an embedded firmware build (ESP32 + NEO-M8N + custom NTP
code). After re-evaluation the path was changed to a Raspberry Pi
running chrony + gpsd + kernel PPS. Reasoning recorded in detail in the
new repo's `HANDOVER.md`; short version:

- chrony is what most public stratum-1 servers actually run; ESP32
  hobby code has to re-implement leap seconds, holdover, multi-source
  comparison, and stratum honesty — chrony already does this correctly.
- Linux kernel timestamps NTP packets at NIC level; ESP32 lwIP does
  this in userspace. Client-visible accuracy ends up better on the Pi.
- Wired Ethernet by default vs Wi-Fi NTP jitter swamping ESP32's local
  PPS lock.
- Debug with SSH + `chronyc` + `gpsmon` rather than serial console +
  logic analyzer.

Local directory renamed `~/projects/ESP32 GPS NTP/` →
`~/projects/Pi GPS NTP Server/`.

#### How the GPS is sourced

No new GPS hardware was purchased. The existing **QRP Labs QLG1**
(MediaTek chipset, 10 ns RMS PPS) that already feeds the U3S beacon
was tapped via its unused **6-way connector**. The U3S retains its
own connection on the 4-way header and is electrically undisturbed.

QLG1 outputs are 5 V (74ACT08 buffers from +5 V rail). Pi GPIO is not
5 V tolerant. Each tapped signal (TXD, PPS) goes through a
2.2 kΩ + 3.3 kΩ voltage divider that drops 5 V → 3.0 V — comfortably
above the Pi's input-high threshold (~2.3 V) and well below the 3.6 V
absolute max. Three wires from QLG1 6-way pins 3 (TXD), 5 (1PPS),
6 (GND) to Pi physical pins 10 (GPIO15 / UART RX), 12 (GPIO18),
6 (GND).

#### Software stack

- **Pi OS Lite, 64-bit, Trixie** (Bookworm successor — current Imager
  default). Headless install via Imager OS Customisation with hostname
  `gpsntp` and SSH public-key auth.
- `/boot/firmware/config.txt` adds: `enable_uart=1`,
  `dtoverlay=disable-bt` (frees PL011 from BT for GPIO14/15), and
  `dtoverlay=pps-gpio,gpiopin=18`.
- Serial login console disabled via `raspi-config`.
- **`gpsd 3.25`** parsing NMEA from `/dev/serial0`, exporting PPS via
  SHM-2. `GPSD_OPTIONS="-n"` so it polls without waiting for clients
  (critical — without this chrony never gets data).
- **Kernel PPS** via `pps-gpio` overlay on GPIO18 → `/dev/pps0`.
- **chrony** with:
  - `refclock SHM 0 refid NMEA offset 0.0 delay 0.2 noselect` —
    gpsd's coarse second-of-time, used only to label which integer
    second the PPS edge belongs to.
  - `refclock PPS /dev/pps0 lock NMEA refid PPS` — kernel PPS device,
    locked to NMEA's second-numbering. The actual time source.
  - `allow 192.168.1.0/24` and `allow fd00::/8` (IPv6 ULA, so
    `sntp gpsntp.local` from the Mac doesn't get a "recv failure" on
    its first IPv6 attempt before falling back to IPv4).

#### Achieved performance (first lock)

| Metric | Value |
|--------|-------|
| Reference ID | PPS |
| Stratum | 1 |
| PPS error | ±152 ns |
| System clock vs GPS truth | 35 ns slow |
| Skew | 0.009 ppm |
| Root dispersion | 18 µs |

Mac (`MiniM4-Pro`) configured as client via
`sudo systemsetup -setnetworktimeserver gpsntp.local`. `timed`
disciplines the Mac continuously; observed offset 1–4 ms on the LAN
(limited by macOS scheduling jitter, not the Pi or the network).

SkimServer Mac, the U3S, and any other shack PCs all gain a precise,
LAN-local, internet-independent time source by way of the Mac (or by
pointing them at `gpsntp.local` directly).

#### Repo contents

- `BUILD.md` — full step-by-step procedure with per-stage verification
  and a detailed troubleshooting section.
- `HANDOVER.md` — context, decisions made, ops-checks block for
  future diagnosis.
- `README.md` — landing page with perf headlines and the
  why-Pi-not-ESP32 case.
- `LICENSE` — MIT, © 2026 Manoj Kumar R (VU2CPL).

#### Known risk parked

When the U3S transmits, the QLG1 sits next to the transmitter and may
RFI-desensitize. This is a pre-existing condition of the U3S+QLG1
combination; the new NTP server is downstream of it. If `chronyc
tracking` shows fix-loss during transmissions over the next week or
two, fall back to a dedicated NEO-M8N + antenna for the Pi (path
documented in `pi-gps-ntp-server/HANDOVER.md`). HANDOVER follow-up #10.

---

### gpsntp — first Pi onboarded via `DEPLOY_PI.md`

Companion to the GPS NTP server above, and the first real-world
exercise of the new `DEPLOY_PI.md` runbook. The `gpsntp` Pi was added
to the RPi Fleet Monitor agent set:

- `rpi_agent.py` deployed to `/home/vu2cpl/`. Active on :7799,
  HTTP 404 probe verified.
- `monitor.sh` deployed to `/home/vu2cpl/`. Per-minute crontab line
  `* * * * *  /home/vu2cpl/monitor.sh` publishes 7 MQTT topics
  (`cpu/mem/temp/disk/uptime/ip/status`) under `rpi/gpsntp/` to broker
  @ 192.168.1.169.
- `rpi-agent.service` deployed to `/etc/systemd/system/`. Enabled +
  active.
- Sudoers entry `/etc/sudoers.d/rpi-agent`:
  `vu2cpl ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown`.

Smoke test (`mosquitto_sub -h 192.168.1.169 -t "rpi/gpsntp/#" -v -C 7`)
caught all 7 messages cleanly. Important note for `DEPLOY_PI.md`
follow-up: `monitor.sh` publishes without `-r` (retain), so the
smoke-test subscriber must be subscribed *before* `monitor.sh` runs —
otherwise the messages fly past the broker and the sub hangs waiting
for retained data that isn't there. Worth folding into the runbook so
the next Pi onboarding doesn't get tripped by it.

The Node-RED `httpDevices` map (function `a0695975fec84e2c`) still
needs `'gpsntp':'http://gpsntp.local:7799'` added so the
Reboot/Shutdown buttons surface for the new host. Tracked as HANDOVER
follow-up #9.

---

## 2026-05-10

### Lightning Antenna Protector — Tier 1 cleanup (drop dead nodes/wires/vars)

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)

Audit pass after the Shack-tab merge, the bypass switch landing, and
yesterday's "minor cleanup of unused nodes" cleared visible deadwood.
80 → 78 nodes; flows.json -33 lines net.

#### Deleted nodes

| Node | Why dead |
|------|----------|
| `Save Reconnect` (`c95abd88`) | Listened for `msg.topic === 'reconnect_change'`. No node anywhere emits that topic. The real handler is `Save Reconnect HTTP`, fed by `POST /lightning/reconnect`. |
| `UI Stats` (`a870e611`) | Body was literally `return msg;`. Pure passthrough with no inbound wires — orphan. |

#### Deleted wires

| Wire | Why dead |
|------|----------|
| `Parse Weather → Header` output 2 → `Master Dashboard` | The Shack-tab merge stripped the weather card from Master Dashboard. The dashboard's `type:'weather'` handler was deleted in that pass. Operator went one further and reduced the function's output count from 2 → 1, so `msg2` is no longer constructed. |
| `AS3935 within threshold?` output 1 → `Send Radio Command` | At that point in the chain `msg.payload` is the strike object (not `'ON'/'OFF'`), so Send Radio Command's guard returned `null`. The intended OFF for the radio comes via `Trigger Disconnect → Send Radio Command` with proper payload — that path is unchanged. |

#### Stripped flow-context vars

`map_count` / `connectCount` / `wssStatus` were initialised in
`Init Defaults` and incremented in `Strike → Dashboard` and
`AS3935 → Dashboard`, but had no readers — the consumers (the strike
map and an old WS status panel) were both removed earlier this week.
Three lines out of `Init Defaults` plus the two-line `count = …` /
`flow.set('map_count', …)` block removed from each of the two
dashboard handlers.

#### Verified

- Bypass toggle still works (banner + countdown + force-reconnect)
- TEST inject still triggers full disconnect chain
- AS3935 panel still updates from heartbeat / status frames
- Header weather card still renders (only the duplicate Master
  Dashboard wire was removed)
- Reconnect Timer still cancels on bypass-on

#### Pending (deferred to Tier 3)

- Rename `Replay on lightning tab` → `Replay Bypass State`
  (post-Shack-tab the old name is misleading)
- Demote Init Defaults `node.warn` to `node.log`
- Merge `Strike → Dashboard` and `AS3935 → Dashboard` (90% duplicated
  payload construction)

---

### Lightning Antenna Protector — Tier 2 cleanup (drop passthroughs)

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)

Two more middleman nodes deleted; tab 78 → 76 nodes; flows.json -32 lines net.

#### `Check Threshold` (`b9d407d9`) — deleted

The strike chain ran `… → Haversine Distance → Check Threshold →
Within threshold? → Trigger Disconnect`. Check Threshold computed
`msg.shouldDisconnect` and `msg.thresholdKm` and updated its own
status badge — but **no downstream node read either field**. The
following `Within threshold?` switch evaluates `msg.strike.distance_km`
against `flow.threshold_km` directly, bypassing the computation.

Pure indirection node. Deleted; Haversine Distance output 1 now wires
straight to `Within threshold?` (and continues to wire to
`Strike → Dashboard` for the dashboard alert).

Also drops one msg-mutation per strike (≈12 strike events/hour during
active storms — small, but it's still N less work).

#### `Refresh Stats` (`61dca3d9`) — deleted

Body was literally `return msg;`. Existed only to fan out the 30 s
tick from the `Stats refresh every 30s` inject to 5 destinations:
`Sync Switch State`, `Stats → Dashboard`, `Log → Dashboard`,
`Replay on lightning tab`, `Replay AS3935 State`.

Deleted. The inject node's wires array now contains those 5
destinations directly — Node-RED's inject natively supports
multi-destination fan-out, no helper needed.

#### Verified

- TEST inject fires full disconnect chain
- `TEST ✅ 120 km safe` correctly skips disconnect
- Bypass banner + countdown still replay across page refresh
- AS3935 panel "Last seen" updates on the 30 s tick
- Stats box numbers update after strikes

---

### Lightning Antenna Protector — Tier 3 cleanup (rename + dedup + trim)

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)

Three follow-up cleanups + one consistency fix; tab 76 → 75 nodes.

#### Renames + small tweaks

- `Replay on lightning tab` → **`Replay Bypass State`**. The old name
  was a relic from when the lightning UI had its own dashboard tab.
  After the 05-08 Shack-tab merge, that label was misleading. New name
  describes what the function actually does: emit `bypass_state` on
  the 30 s tick so the bypass banner survives page refresh.
- `Init Defaults` `node.warn(...)` line **deleted**. The existing
  `node.status({...})` already shows broker, callsign, threshold,
  reconnect-min in the node's badge — the warn was just spamming
  the in-editor debug sidebar on every deploy.

#### Strike → Dashboard / AS3935 → Dashboard merge

Two functions, ~25 lines each, ~90 % duplicated payload construction.
Merged into a single `Strike → Dashboard` that handles both paths.

Detection inside the function:

```js
const isAS3935 = (msg.strike.source || '').toLowerCase().indexOf('as3935') !== -1;
```

If true: payload gets `source:'as3935'` and `energy:<n>` fields. If
false: those fields are omitted (matches old OM payload shape exactly).

Both upstream nodes (`Haversine Distance` for OM/TEST, `AS3935 Threshold
Check` for AS3935) already populate `msg.strike` with `lat`, `lon`,
`distance_km`, `time`, and `source`. AS3935 Threshold Check additionally
sets `msg.strike.energy`. So the unified function only reads from
`msg.strike` regardless of source.

Wiring:
- `Strike → Dashboard` (the unified function) is now fed by
  `Haversine Distance` AND `AS3935 Threshold Check` (the function
  *before* the AS3935 threshold switch).
- `AS3935 → Dashboard` deleted.

#### AS3935 banner consistency fix

The first wiring attempt fed `Strike → Dashboard` from
`AS3935 within threshold?` output 1 (within-threshold strikes only),
which was a behavior change from the old `AS3935 → Dashboard` (fed
by both switch outputs). That made AS3935 distant strikes silently
log to the event log without firing the alert banner — inconsistent
with the OM path, where `Haversine → Strike → Dashboard` runs
unconditionally and the banner colours by km.

Corrected: rewired to feed `Strike → Dashboard` from
`AS3935 Threshold Check` (one node *earlier*, before the switch).
All AS3935 strikes now fire the banner; the colour distinguishes
within-threshold (red) vs. nearby (amber) vs. far (green), exactly
like OM.

#### `Within threshold?` switch trim

Operator noticed that the OM-path `Within threshold?` switch had two
output ports, only one of which was wired. The `else` branch was
genuinely unneeded:
- The alert banner for distant OM strikes already fires upstream via
  `Haversine Distance → Strike → Dashboard` (no threshold filter on
  that branch).
- The event log for OM polls is already populated by
  `Parse Open-Meteo → Strike` output 2, regardless of distance.

Switch reduced from 2 rules / 2 outputs to 1 rule (`≤ threshold_km`)
/ 1 output. (The `AS3935 within threshold?` switch is unchanged —
its out2 is genuinely used by `AS3935 Warn Log`.)

#### Tier-by-tier audit summary

| | Start | After T1 | After T2 | After T3 |
|---|---|---|---|---|
| Nodes on Lightning tab | 80 | 78 | 76 | **75** |

Net for this audit pass: -5 nodes, several dead wires removed,
duplicated payload-construction merged, naming brought into line
with current architecture. No behavioral changes for the operator
beyond consistency (AS3935 distant strikes now banner-render).

---

### Documentation — README split into umbrella + DXCC reference

The repo's `README.md` predated everything except DXCC and was
effectively the DXCC reference doc with a station footer. Reflowed:

- **`README.md`** — new umbrella overview. Hardware table, an
  11-subsystem summary (Lightning / SPE / FlexRadio / Power / Solar /
  LP-700 / Rotor / DXCC / RPi Fleet / Internet & Network / RBN
  Skimmer), a repo-layout file tree, and a documentation map
  pointing at each detailed reference. ~290 lines.
- **`DXCC.md`** — new file. The previous README content moved here
  verbatim (retitled and reframed as a subsystem reference, with a
  link back to `README.md`). All node IDs, alert types, startup
  sequence, persistence logic preserved.
- **`DXCC_Tracker_README.pdf`** — regenerated from `DXCC.md` instead
  of `README.md`. Same name, same role.
- **CLAUDE.md rule #3** updated: the "regenerate the PDF when you
  edit the doc" pairing now refers to `DXCC.md` ↔
  `DXCC_Tracker_README.pdf`, not the old README pairing.
- Header line in this changelog updated to point at `DXCC.md`.

Future per-subsystem deep-dive docs (e.g. a hypothetical
`LIGHTNING.md`) can now slot in cleanly without bloating the front
page on GitHub.

---

### Rebuild runbook + missing systemd unit

The repo had `rpi-agent.service` checked in (since 2026-05-09) but
**not** the AS3935 daemon's systemd unit (`as3935.service`). Disaster-
recovery had a real gap: if the SD card died, you'd be reconstructing
the install path from CLAUDE.md fragments and memory.

#### `as3935.service` checked in

Pulled verbatim from `/etc/systemd/system/as3935.service` on the
Pi. Standard `User=vu2cpl`, `Restart=always`, `WorkingDirectory=
/home/vu2cpl`. Added to the "Pi-side scripts in this repo" table
in CLAUDE.md alongside `rpi-agent.service`.

#### `REBUILD_PI.md` runbook added

A new top-level doc — linear, copy-pastable, "blank SD card to
working shack" sequence in 12 steps:

1. OS install (Pi OS Lite 64-bit), hostname, SSH, DHCP reservation
2. System packages (`mosquitto`, `python3-paho-mqtt`, `python3-rpi.gpio`,
   `i2c-tools`, build tools); enable I²C + UART
3. Mosquitto LAN-only config + autostart
4. Node-RED via official installer + 9 palette packages + Projects
   feature in settings.js
5. GitHub SSH key → clone the project (Projects-feature path or
   manual git clone) → `nrsave` git alias setup
6. `enable_file_context.sh` for persistent flow context
7. Pi-side scripts deploy: `as3935_mqtt.py`, `as3935.service`,
   `rpi_agent.py`, `rpi-agent.service`, `monitor.sh` (cron),
   `power_spe_on.py`. Sudoers entry. Ownership reset (the 05-07
   quirk explicitly called out).
8. Hardware setup: udev rules for Telepost / LP-700, AS3935 wiring
   confirmation (IRQ on **GPIO4** not GPIO17)
9. `lp700-server` install via VU3ESV's `redeploy.sh`
10. Manual paste of DXCC + Telegram credentials into the
    `⚙️ Credentials` node (these aren't in the repo — were rotated
    after the 05-09 plaintext-leak audit)
11. Tasmota broker pointer check (no-op if the new Pi keeps
    `192.168.1.169`)
12. 12-point final-verification checklist (ping, dashboard,
    MQTT, AS3935 heartbeat, RPi telemetry, LP-700 telemetry,
    FlexRadio TCP, Tasmota state sync, DXCC alerts, lightning
    auto-disconnect)

Plus a 6-row common-failure-modes table.

CLAUDE.md and README.md cross-link the new runbook. README's
"Documentation map" now distinguishes:
- `REBUILD_PI.md` = **the shack Pi** (this repo, full install)
- `DEPLOY_PI.md` = **a different Pi** as a fleet member (telemetry +
  reboot agent only)

---

### DXCC — N2WQ disconnect cycle + secrets out of flows.json

**Tab:** DXCC Tracker (`d110d176c0aad308`)
**Nodes:** `⚙️ Credentials (edit once)` (`08dcd537`),
`Login + Parse + Dedup` (`login-parse-dedup-v2`)

#### The disconnect cycle

N2WQ was kicking us in a tight loop with `Another login with your call.
This session is being closed (multiple logins are not allowed)`. tcp-in
auto-reconnect produced a new session every ~10 s and the loop never
broke. Two interlocking causes:

**1. Login regex matched the welcome banner.** The original detector was

```js
line.toLowerCase().includes('login:')
```

N2WQ-2's welcome banner contains `Last login: (first login) from <ip>`.
That triggered a *second* `VU2CPL\r\n` send after we'd already
authenticated. AR-Cluster treats the second send as a command, replies
`Unknown command: VU2CPL`, and ~10 s later the duplicate-login policy
kicks the session.

Fixed by tightening the detector to match a *prompt*, not a banner
mention:

```js
var lc = line.trim().toLowerCase();
if (lc.length < 40 && (
    lc.endsWith('login:') ||
    lc.endsWith('please login') ||
    lc.endsWith('please login:') ||
    lc.endsWith('callsign:') ||
    lc.endsWith('callsign please:') ||
    lc.endsWith('your callsign:') ||
    lc.endsWith('enter your callsign:')
)) { ... }
```

The `length < 40` guard kills false positives in the 412-char welcome
banner. `endsWith` confirms we're at a *prompt* waiting for input,
not a mid-banner reference.

**2. Another VU2CPL client was on the LAN.** With the regex fix in,
we *still* got kicked. Confirmed via `nc cluster.n2wq.com 8300` —
even with Node-RED stopped, manual `VU2CPL` login was kicked, but
a different test callsign stayed connected. Some other LAN device
(unidentified — not Mac, not Pi; possibly an iOS app, logging
program, or forgotten `nc` session) was also logged in as
`VU2CPL`. AR-Cluster's "no duplicate logins" enforcement was
firing.

Sidestepped using a packet-radio SSID:

- **Credentials node** got a new `cl_login_ssid: '-1'` config
- **Login + Parse + Dedup** now sends
  `(flow.get('cfg_cl_callsign') || 'VU2CPL') +
   (flow.get('cfg_cl_login_ssid') || '') + '\r\n'`

So Node-RED logs in as `VU2CPL-1` and the other unidentified `VU2CPL`
client coexists peacefully. AR-Cluster treats `-1`–`-15` SSIDs as
distinct users (standard packet-radio convention).

Verified `VU2CPL-1` accepted by N2WQ-2 via manual `nc` test before
deploying.

#### Secrets out of flows.json

While the Credentials node was being touched anyway, the API key,
password, and Telegram token were moved from inline-in-function to
systemd environment variables. The motivation isn't repo exposure
(repo is private) — it's rotation friction. Previously each rotation
required: edit node → Done → Full Deploy → `nrsave` → push. With
env-vars: edit `/etc/systemd/system/nodered.service.d/secrets.conf` →
`systemctl restart nodered`. One step, no commit needed.

Setup on the Pi:

```bash
sudo mkdir -p /etc/systemd/system/nodered.service.d/
sudo tee /etc/systemd/system/nodered.service.d/secrets.conf <<'EOF'
[Service]
Environment="CLUBLOG_API_KEY=<key>"
Environment="CLUBLOG_PASSWORD=<pwd>"
Environment="TELEGRAM_TOKEN=<token>"
EOF
sudo chmod 600 /etc/systemd/system/nodered.service.d/secrets.conf
sudo systemctl daemon-reload
sudo systemctl restart nodered
```

The Credentials node now reads each via `env.get('VAR_NAME')` with a
pre-flight validation block — if any of the three are missing it
fires `node.error()` and a red status badge so misconfiguration is
loud, not silent.

`cl_email`, `cl_callsign`, `cl_login_ssid`, `tg_chat_id`, and
`cfg_flows_dir` stay inline in the Credentials node — they aren't
sensitive and rarely change.

#### Diagnostic notes for future-self

- **AR-Cluster forks (like N2WQ-2) don't have a `WHO` command.**
  `HELP` showed only spot/filter commands; no way to query who
  else is logged in as your call. `SH/USER`, `WHO`, `LIST USERS`
  all returned `Unknown command`.
- `tcpdump` on the Pi only sees the Pi's own packets — switch
  doesn't mirror unicast LAN traffic to the Pi's NIC. Not useful
  for finding which LAN device is talking to a remote IP. Brute-
  force quit / power-down was faster than network capture for
  identifying the offender (though we never positively identified
  it; the SSID workaround sidestepped the need).

#### Pending follow-ups

- Remaining ghost VU2CPL session on the LAN — never identified.
  Currently harmless thanks to the `-1` SSID workaround, but
  worth tracking down eventually (search `tmux` / `screen`
  sessions, iOS apps, logging programs).
- API key + Telegram token historical commits — rotation
  recommended if/when the repo is ever made public. Currently
  private.

---

### DXCC — startup-fetch trigger fixed + Bootstrap unblocks tracker without Club Log

**Tab:** DXCC Tracker (`d110d176c0aad308`)
**Nodes:** `Load Club Log on startup`, `Retry Club Log (90s)`,
`Bootstrap Worked Table (manual seed)` (`1a13cd6d`)

#### Symptom

After deploying the secrets-to-env-var change, the dashboard stopped
showing alerts and `DXCC Prefix Lookup + Alert Classify` was stuck on
`Paused — reference data loading...`. Cluster spots were arriving fine
(cluster-status panel green, counters incrementing), but no prefix
lookup, no alert classification.

#### Root cause #1 — startup injects had `once: false`

`Load Club Log on startup` and `Retry Club Log (90s)` both had the
"Inject once after start" checkbox **unticked**. Their `onceDelay`
was set (12 s and 90 s respectively) but ignored. Result: the only
nodes that triggered the Club Log fetch were the `0200` cron and the
manual UI button. After every Node-RED restart the tracker stayed
paused for the entire day until the cron fired or the operator
manually re-triggered.

This had been latent since some earlier deploy — surfaced today after
the secrets-to-env-var redeploy made all the symptoms acute.

Fix: ticked the once-on-startup checkbox on both injects. Now every
deploy fires Club Log fetch at +12 s, with a +90 s safety retry.

#### Root cause #2 — `dxccReady` only set by live Club Log fetch

`DXCC Prefix Lookup + Alert Classify` gates on
`flow.get('dxccReady') === true`. That flag was set ONLY by
`Fetch All Modes + Parse` (or its lotw-only sibling) on a successful
Club Log API response. `Bootstrap Worked Table` loaded cached data
from `nr_dxcc_seed.json` (which is git-tracked and always fresh on a
clone) but never flipped the flag.

Result: any time Club Log was unreachable / auth failed / rate-limited,
the tracker stayed paused even though all the worked-data was already
loaded from cache. Brittle.

Fix: `Bootstrap Worked Table` now sets `flow.set('dxccReady', true)`
in all three of its success branches:

1. **File store branch** — when `flow.get('workedTable', 'file')` returned cached worked-table from the file context store.
2. **Already-loaded branch** — when `flow.workedTable` was already populated from a previous run (idempotent re-set).
3. **Seed-file branch** — when `nr_dxcc_seed.json` was read from disk.

Now the tracker is operational within ~2 s of any restart, regardless
of Club Log availability. Live fetch (when it works) overlays fresh
data on top later — idempotent.

#### Verified

- Manual trigger of `Load Club Log on startup` post-secrets-deploy →
  `Fetch All Modes + Parse lotw only` turned green with entity count;
  `dxccReady` flipped true; Prefix Lookup unpaused
- Inject once-on-startup checkbox now persisted across re-import
- Bootstrap fix: even with Club Log fetch artificially blocked,
  Prefix Lookup stays unpaused on a fresh restart (cached data alone
  is sufficient for operation)

#### Diagnostic notes for future-self

- AR-Cluster forks (N2WQ-2) don't have a `WHO` command — can't query
  who else is logged in as your call. Brute-force device-by-device
  was faster than network capture for finding LAN duplicates.
- Bootstrap's status colours: blue = "Restored from file store",
  green = "Loaded from nr_dxcc_seed.json", grey = "Already loaded".
  All three are success states — only red = "File not found" indicates
  a real problem.
- "No status" on a function node means it hasn't processed a message
  since last deploy. Not an error. Wait for the next message.

#### Correction (same day)

The "fix" of ticking the once-on-startup checkbox on
`Load Club Log on startup` and `Retry Club Log (90s)` was wrong.
Those injects had been deliberately set to `once: false` as an
anti-ban measure — Club Log had previously rate-limited / banned
the API key for over-eager re-fetches, and the operator's design
was to fetch ONLY via the 02:00 cron (1 API call/day) and rely on
`Bootstrap` reading from `nr_dxcc_seed.json` for startup
operation. CLAUDE.md TODO #10 ("verify Club Log API ban status +
re-enable nodes if lifted") had been the trail; it was missed
during the diagnosis.

**The Bootstrap-sets-`dxccReady` fix turned out to be the entire
correct answer** — it makes the tracker functional from cached
data on every restart with zero API calls. The once-on-startup
checkboxes have been reverted.

Final design (post-correction):

| Trigger | What runs | Club Log API hits |
|---|---|---|
| Pi restart / Node-RED redeploy | Bootstrap loads `nr_dxcc_seed.json` → flips `dxccReady=true` | **0** |
| Daily 02:00 (cron) | `Daily club log refresh (0200)` → fetch + refresh seed | 1 / day |
| Operator manually clicks `Load Club Log on startup` inject | One-shot fetch | 1 / click |

Lesson for future-self: **TODO #10's "Pending" status was a real
constraint, not a stale note**. When in doubt about a node that
looks "broken" but is intentionally disabled, check CLAUDE.md
TODOs / HANDOVER follow-ups before flipping it.

---

### DXCC — `Login+Parse+Dedup` was emitting wrong spot field names (real regression)

**Tab:** DXCC Tracker (`d110d176c0aad308`)
**Nodes:** `Login + Parse + Dedup` (`login-parse-dedup-v2`),
`DXCC Prefix Lookup + Alert Classify` (`b981643f`)

#### Symptom

User reported "I was getting alerts a few per hour earlier — now
nothing" despite all 4 cluster cards green and spots flowing.
The `DXCC Prefix Lookup + Alert Classify` node had **empty status**
— never updating, never firing alerts.

#### Root cause — field-name mismatch between two functions

`Login + Parse + Dedup` was emitting spots as:

```js
spot: { seq, dxCall, freqKHz, freqMHz, mode, spotter, comment, src }
```

But `DXCC Prefix Lookup + Alert Classify` was reading:

- `spot.call` — for blacklist check, DXCC resolution, status text,
  alert payloads
- `spot.band` — for band filtering and band-worked classification

Neither field was being set by the upstream parser. So Prefix
Lookup hit this line near the top:

```js
var band = (spot.band || '').toString().toUpperCase().trim();
if (!band) return null;   // silent return — no status update
```

…and silently returned on every real spot. Empty status, no alerts,
forever.

The `TEST P5ABC` / `TEST C6ABC 160M` / etc. inject buttons that
feed Prefix Lookup directly **were setting `call` and `band`
correctly** in their payloads, which is why manual-test alerts
fired but real cluster spots never did. That masked the bug for
some unknown duration.

#### Fix

Added a `getBand(khz)` helper inside `Login + Parse + Dedup`
(standard amateur band ranges, kHz → band name) and updated the
emitted spot object:

```js
spot: {
    seq:      seq,
    call:     dxCall,         // ← NEW — what Prefix Lookup reads
    dxCall:   dxCall,         //         kept for any legacy consumer
    freqKHz:  freqKHz,
    freqMHz:  freqMHz,
    mode:     mode,
    band:     getBand(freqKHz),   // ← NEW
    spotter:  spotter,
    comment:  comment,
    src:      src
}
```

`call` is added alongside `dxCall` (rather than replacing) so
nothing else that reads `spot.dxCall` (e.g. SmartSDR command
construction earlier in the function) breaks.

#### Verification

After deploy, `DXCC Prefix Lookup + Alert Classify` immediately
started showing per-spot activity:
- Grey ring `K1ABC worked (United States 20M)` for already-worked
- Red/blue/yellow on actual alerts

#### Sequence of today's diagnostic missteps (worth recording)

1. Symptom appeared after the secrets-to-env-var redeploy →
   wrongly attributed to Club Log fetch failure
2. Investigated `dxccReady` flag → made Bootstrap unilaterally
   set it (correct fix, but for a different problem)
3. Ticked once-on-startup checkboxes → wrong fix; reverted
4. Verified all clusters green / spots flowing → realised the
   issue is downstream of the parser
5. Read both function bodies side-by-side → found the field-name
   mismatch

Lesson: when a node has empty status and the symptom is
"downstream silence despite upstream activity", suspect a
field-name mismatch between producer and consumer before
suspecting flag/state issues. Should have read both function
bodies first.

---

### RPi Fleet — Chrony / GPS Time Server card

**Tab:** RPi Fleet Monitor (`d5fec2fea3dd37f4`) — eventual home
**Source of truth:** [`vu2cpl/pi-gps-ntp-server`](https://github.com/vu2cpl/pi-gps-ntp-server),
`dashboard/` folder

#### What

A single `ui_template` widget showing live status of `gpsntp.local`
(the stratum-1 GPS-disciplined NTP server installed 2026-05-09).
Replaces a transitional seven-widget version on a dedicated `GPS NTP`
dashboard tab.

#### Data source

| | |
|---|---|
| Broker | `192.168.1.169:1883` (the existing shack MQTT broker) |
| Config node | reuses existing `mqttbroker.shack` — **do not duplicate** |
| Topic | `shack/gpsntp/chrony` |
| QoS | retained, JSON, refreshed every minute |
| Publisher | `/usr/local/bin/gpsntp-mqtt-publish.sh` on `gpsntp.local` (Pi-side cron, NOT in this repo) |

Because the topic is retained, any new subscriber gets the latest
snapshot the moment it connects.

#### Payload

```json
{
  "host": "gpsntp",
  "ts": 1747032600,                 // Unix epoch seconds
  "ref_id": "50505300",             // chrony hex ref id
  "ref_name": "PPS",                // PPS / NMEA / pool host etc.
  "stratum": 1,                     // 1 healthy, 16 unsynced
  "system_time_offset_s": -3.5e-08,
  "last_offset_s": 1.52e-07,
  "rms_offset_s": 2.1e-07,
  "freq_ppm": 0.142,
  "skew_ppm": 0.009,
  "root_delay_s": 0.0,
  "root_dispersion_s": 1.8e-05,
  "leap": "Normal",
  "fix_mode": 3,                    // 0/1/2/3 = none/nofix/2D/3D
  "sat_used": 9,
  "sat_seen": 12
}
```

#### Architecture

- One `mqtt in` → one `ui_template`. **No function node in between** —
  all formatting + threshold logic lives in the template's AngularJS
  `<script>`.
- CSS namespaced under `.gpsntp-card` so it doesn't bleed into other
  widgets.
- Footer: UTC clock (`HH:MM:SS UTC`, derived from `ts`) plus a
  `setInterval` ticker that updates the relative "N s ago" stamp every
  5 s without re-rendering the card. Interval cleared on `$destroy` so
  navigating between tabs doesn't leak.
- `ui_group` width 6 to match other dashboard panels; inner card uses
  `width: 100%` (no max-width) so it fills whatever group width is
  assigned.

#### Attention thresholds

Value rendered in orange when crossed:

- `|system_time_offset_s|` > 1 ms
- `rms_offset_s` > 1 ms
- `root_dispersion_s` > 5 ms
- `|skew_ppm|` > 1
- `ref_name` ≠ PPS / PPS2
- `fix_mode` ≠ 3

#### Updating the widget — preferred path

1. **In-place edit** — open the existing Chrony status card
   `ui_template` node, replace the format box with
   `dashboard/chrony-card-template.html` from `pi-gps-ntp-server`,
   Done → Deploy. Doesn't disturb the group / position.
2. **Re-import the flow** — only if you also want to replace the
   broker / mqtt-in nodes. Use Import → "Copy" (not "Replace") and
   move the new `ui_template` into your group, otherwise the import
   resets the widget's position.

#### Gotchas

- The core MQTT input node's type string is `"mqtt in"` (with a
  space), not `"mqtt-in"`. Only the broker config node uses the
  hyphen (`mqtt-broker`). Hand-built flows that get this wrong are
  rejected on import as "unknown types".
- The publisher publishes Unix epoch in `ts`. The widget formats it
  as **UTC** for the footer (ham radio convention). Do **not** switch
  to `toLocaleString()` — that's a local-time bug we already fixed
  elsewhere.

#### Required palette

`node-red-dashboard` (classic Angular dashboard, **not** Dashboard 2.0).
The widget uses `ui_template`, `ui_group`, `ui_tab`.

#### Current state

- `743a0d8` pushed the transitional seven-widget version on a
  dedicated `GPS NTP` flow tab (id `4cac0c07e2686c33`).
- `286348e` migrated to the single `ui_template` design — the new
  card lives on flow tab `GPS NTP (card)` (id `4590ed80de4873b1`)
  with just two nodes: `mqtt in shack/gpsntp/chrony` and
  `Chrony status card` ui_template (id `38e130c3`). Dashboard tab
  is `Shack Monitoring tools`, group `Network Monitor` (width 6).
- The orphan `GPS NTP` flow tab was subsequently deleted by the
  operator (closes HANDOVER follow-up #13).

---

### `rebuild_pi.sh` — automated rebuild script

Disaster-recovery just got faster. `REBUILD_PI.md` (Pi-rebuild
runbook from 2026-05-09) was a manual copy-paste sequence taking
~90 minutes. Wrapped it in a single bash script that automates
Stages 2–13 (everything after the SD-card burn).

`rebuild_pi.sh` highlights:

- **Stage-based, 1:1 with REBUILD_PI.md numbering.** Each stage
  has its own function (`stage_01_apt_packages`, …,
  `stage_13_verify`), prints a banner, runs commands with
  `set -euo pipefail`, marks itself done in a state file.
- **Resumable.** State persisted in `/tmp/rebuild_pi.state`. After
  Ctrl-C or unexpected reboot, re-run and it skips completed
  stages. `--reset` wipes the state file. `--stage N` re-runs a
  single stage. `--status` lists what's done.
- **Idempotent.** Every operation safe to re-run. apt installs
  are no-ops once present; npm install skips already-installed
  packages; clones detect existing repo and `git pull` instead;
  systemd `enable --now` is idempotent; sudoers entry uses `tee`
  with overwrite; cron is grep+tee idempotent.
- **Two interactive pauses** (necessarily so):
  1. Stage 6 — generate ed25519 keypair, print pubkey, wait for
     operator to paste it into GitHub Settings → SSH keys
  2. Stage 12 — `read -s` for Club Log API key, password,
     Telegram token (no echo); written to
     `/etc/systemd/system/nodered.service.d/secrets.conf`
- **Fail-fast pre-flight.** Refuses to run as root (sudo only
  when needed). Verifies hostname, internet, sudo auth.
- **Built-in verification** at Stage 13 — 10-point checklist
  matching REBUILD_PI.md Step 12 (ping, Node-RED editor + UI,
  Mosquitto, as3935 service, rpi-agent, lp700-server `/healthz`,
  three MQTT topic smoke-tests). Pass/fail summary; pointer to
  manual diagnosis on failures.
- **Coloured output** (red/green/yellow/blue helpers) for at-a-
  glance progress.

Wall-clock target: ~30 min vs. ~90 min manual. Uses include the
obvious "shack Pi died, rebuild" plus quicker iteration on test
Pis or VMs.

The script lives next to REBUILD_PI.md as a peer source-of-truth.
The runbook stays as the **manual fallback** when the script
breaks (which it eventually will, e.g. when Pi OS bumps a major
version). The two must stay in sync — script banners reference
the runbook's section numbers.

REBUILD_PI.md updated to point at the script as the faster path,
with a one-paragraph summary at the top before the manual steps.

---

### Power meter panels — auto-scale + 10 px bars + stable colours

**Tabs / nodes:** LP-700-HID ws (`18fb42443172f33c`) `LP-700 Panel`
(`c638a0991ad0b768`); SPE (WS) (`spe_ws_tab_01`) `SPE Panel (WS)`
(`ws_panel_node`).

Both power-meter panels grew an auto-scaling display bar so single
visual works across QRP through high-power operation without manual
fiddling.

#### Common — auto-scale steps

`5 / 25 / 50 / 100 / 500 / 1000 / 1500 / 2000 / 5000 W`. The bar's
full-scale auto-picks the smallest step ≥ current power. As power
crosses a step boundary, the scale snaps up to the next step and the
bar redraws (typical auto-ranging-meter behaviour).

A small `scale: NW` indicator alongside the relevant header tells
the operator what the bar's full-width represents — separate from
the meter's own range setting (LP-700) or the amp's rated power
(SPE).

#### Common — bar thickness

6 px → **10 px**, with a 1 px border on the track for definition and
an inset shadow on the fill for depth. Conspicuous without being
overwhelming. CSS transitions on `width` and `background-color`
both eased to 0.3 s for smooth movement.

#### LP-700 panel

- Header gets `scale: <auto-picked> W` indicator next to the title.
- Both AVG and PEAK bars share the same auto-scale, computed from
  `max(avg, peak)`. Keeps the visual relationship between AVG and
  PEAK meaningful — peak fills more of the bar than avg.
- **Stable bar colours** — AVG always green (`#3fb950`), PEAK always
  amber (`#e3b341`). The earlier dynamic 70/90 % thresholds were
  rejected after first deploy: with auto-scale, the bar nearly
  always sits in the upper portion of its current band, so the
  threshold colour-shift triggered constantly and stopped meaning
  anything. Solid colours preserve the panel's pre-auto-scale visual
  identity (AVG=green / PEAK=amber).
- SWR bar **keeps** its original threshold logic (1.0–3.0 mapping,
  thresholds at 1.5 / 2.0). SWR colour transitions remain meaningful
  because SWR has fixed safety zones independent of the bar's
  auto-scale.

#### SPE WS panel

Only the Output Power bar got the treatment — SWR bars unchanged.

- Inline `style="height:10px"` on the Output Power track + fill
  (preserves `gh-track` / `gh-fill` defaults at 6 px so ATU SWR and
  ANT SWR stay thin).
- Auto-scale logic identical to LP-700.
- Small `(scale NW)` indicator inline next to the "Output Power"
  label.
- Removed the redundant `currentW / pwrMax W` text on the right side
  of the row. The bar shows the live value visually; the scale label
  shows the bar's full-width; the amp's rated power level is
  already shown in the separate `PWR Lvl` badge above the bar. The
  `currentW / 500W` text was just sitting at "0W / 500W" between
  TXs and adding noise.

#### Diagnostic note for future-self

The LP-700 first attempted the dynamic-threshold colours pattern
(red/amber/green based on % of the current scale step). Looked good
in theory; visually broken in practice because auto-scale always
picks the tight-fitting step → bar always near top → colour stuck
at amber. Lesson: **dynamic colours and auto-scale don't
compose well** — one or the other carries the magnitude info, not
both. We chose to keep auto-scale and drop the dynamic colours.

#### Follow-up — SPE scale label legibility (`0d10af3`)

The first SPE WS scale label was styled `opacity:0.55;font-size:9px`
on top of the dim `gh-lbl` colour, which made it nearly invisible
in practice. Bumped to `font-size:11px;color:#c9d1d9` (the panel's
bright text colour) and dropped the opacity entirely. Operator
also tried bold and rejected it ("too thick") — final version is
unbold.

---

### DXCC — alert-table dedup on `call+band+mode+alertType`

**Tab:** DXCC Tracker (`d110d176c0aad308`)
**Node:** `Format Alert for Dashboard Table` (`2286f0a512733e92`)
**Closes:** HANDOVER follow-up #15

The 60 s dedup in `Login + Parse + Dedup` catches back-to-back
duplicate cluster spots, but identical spots arriving 60+ s apart
(e.g. XE1RK on 15M USB twice within ~75 s — observed today on the
dashboard) re-fired alerts and the alert table rendered the same
NEW MODE / NEW BAND row twice within minutes. Visual noise; no
functional impact.

Added a second-tier dedup at the alert-table level. The existing
TTL-expiry filter on `alerts` was extended in the same pass:

```js
alerts = alerts.filter(function (r) {
    if ((now - (r.ts || 0)) >= ttlMs) return false;
    if (r.call      === row.call      &&
        r.band      === row.band      &&
        r.mode      === row.mode      &&
        r.alertType === row.alertType) return false;
    return true;
});
alerts.unshift(row);
```

Net behaviour: at most one row per `(call, band, mode, alertType)`
combination while inside the spot-lifetime TTL window. New
sighting replaces the old row at the top — its timestamp / freq /
spotter / `time` field reflect the latest hit, so the operator
always sees current info.

This complements the upstream 60 s spot dedup (per-spot
suppression) without conflicting with it. The 60 s window is
short enough to catch packet duplicates from the cluster network;
the alert-table window is the configured spot-lifetime (default
20 min) so alerts don't pile up when the same DX is repeatedly
spotted by different spotters.

No `REBUILD_PI.md` update needed — flows.json change, restored via
git clone.

---

### HANDOVER #3 — Open-Meteo dashboard placeholder — closed as obsolete

The follow-up referred to the `OPEN-METEO MONITOR · Waiting for data…`
badge in the Master Dashboard's `#hdr` block. That entire header block
was stripped during the 2026-05-08 Shack-tab merge (Master Dashboard
moved to a new group on the Shack tab; the dashboard's own header was
removed in favour of the Shack tab's existing Header card).

The badge therefore no longer exists, so the follow-up is moot. OM
polls continue to produce `type:'log'` messages every 5 min via
`Parse Open-Meteo` output 2 → Master Dashboard, which flow into the
event log normally.

No code change. Closing the entry rather than deleting so future-self
sees the rationale.

---

### Format Log — `0 km` strikes now render the distance segment

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)
**Node:** `Format Log` (`5bfc6db2af9dd24c`)
**Closes:** HANDOVER follow-up #4

One-character bug fix in the event-log formatter. Old line:

```js
const dist = msg.distance ? ' | ' + msg.distance + ' km' : '';
```

Truthy check on `msg.distance`. When the AS3935 chip reports an
overhead strike (or an out-of-range strike that we treat as 0 per
the chip's `dist=63 → null → 0` mapping in `AS3935 Threshold Check`),
`msg.distance === 0` is falsy, so the `| 0 km` segment was dropped
from the log line. Fixed with explicit null check:

```js
const dist = (msg.distance != null) ? ' | ' + msg.distance + ' km' : '';
```

Loose `!= null` catches both `null` and `undefined` but not `0` —
exactly the desired semantics.

No `REBUILD_PI.md` update needed — flows.json change, restored via
git clone.

---

### AS3935 systemd hardening

**Unit:** `/etc/systemd/system/as3935.service`
**Repo source:** `as3935.service`
**Closes:** HANDOVER follow-up #2

The original unit had `After=network.target` (kernel-level only) and
`Restart=always`. The 2026-04-21 silent outage that left the daemon
dead for 10 days was caused by the boot-time race where `paho-mqtt`'s
`client.connect()` ran before the network was actually routable.
The May 1 hardening added a Python-side retry loop to the script;
this commit hardens systemd itself as belt-and-braces.

Four directive changes:

| Before | After | Why |
|---|---|---|
| `After=network.target` | `After=network-online.target mosquitto.service` | Wait until network is *fully* up AND broker is ready — not just kernel-level reachability |
| (no `Wants`) | `Wants=network-online.target` | Pulls `network-online.target` into the boot sequence so `After=` actually delays |
| `Restart=always` | `Restart=on-failure` | Don't restart on clean SIGTERM during shutdown |
| (no `RestartSec`) | `RestartSec=5` | Default 100 ms is too aggressive; 5 s lets transient errors clear |

Verified post-deploy:

```
$ systemctl show as3935 -p Restart,RestartSec,Wants
Restart=on-failure
RestartSec=5s
Wants=network-online.target
```

Directives are baked into the base unit (not a `.service.d/override.conf`
drop-in) since we own this unit file. Drop-ins are the systemd-recommended
approach for overriding **distro-provided** units we don't own; for
self-owned units, editing the file directly is cleaner.

The script's own MQTT retry loop (added 2026-05-01) handles broker
disconnects mid-run. This systemd hardening handles the boot-time
case and the post-broker-restart case.

No `REBUILD_PI.md` update needed — `rebuild_pi.sh` Stage 9 already
copies `as3935.service` from the repo, and Stage 13 verifies the
service is active.

---

### Two more follow-ups closed

Brief admin entry — operator-confirmed both items today:

- **CLAUDE.md TODO #4** — RPi agent deployed on remaining Pis +
  HA Pi (Bearer token). Closes the multi-host fleet onboarding
  thread that started 2026-05-09 with `DEPLOY_PI.md`.
- **HANDOVER follow-up #9** — `gpsntp` added to `httpDevices`
  map in `Route CMD: HTTP or MQTT` (function `a0695975fec84e2c`).
  Reboot/shutdown buttons on the Chrony / GPS Time Server card
  now route correctly through the existing fleet HTTP-control
  pipeline (POST `/reboot` / `/shutdown` on `:7799`).

---

### Rotator Auto-Off Timer — 60 s → 5 min for production

**Tab:** All Power Strips (`b76a5310767803b4`)
**Node:** `Rotator Auto-Off Timer` (`05f0ddeb566a90fc`)

Two-character config change. The timer that auto-cuts power to the
rotator (Tasmota `powerstrip1/POWER2`) was set to 60 s back when
this flow was first iterated; the production target was always 5
minutes. Surfaced by HANDOVER follow-up #5 / CLAUDE.md TODO #3.

```js
// before
var duration = 60 * 1000;
node.status({fill:'yellow', shape:'dot', text:'Timer running — 60s'});

// after
var duration = 5 * 60 * 1000;
node.status({fill:'yellow', shape:'dot', text:'Timer running — 5 mins'});
```

The idempotent retrigger guard + 10 s post-OFF cooldown (added
2026-04-22 to break the reset loop from spurious Tasmota stat-republishes)
remain unchanged. Both still operate independently of the duration
value.

`flow.rotatorTimerEnd` (the dashboard countdown anchor) is also
unchanged — it was already computed as `Date.now() + duration` so
it auto-scaled.

Closes CLAUDE.md TODO #3 and HANDOVER follow-up #5.

---

### Lightning — Blitzortung integration dropped from roadmap

`HANDOVER.md` follow-up #7 had been carrying "wire Blitzortung TCP-in
to Parse Strike" since the 2026-05-08 map removal. The parser's
Case 2 (binary frame) and Case 3 (string frame) were left intact
specifically for this future integration.

Verified today on `map.blitzortung.org` — **zero coverage at MK83TE
(13.06°N 77.63°E)**. Southern India has very few contributing
stations and the TOA triangulation algorithm needs ≥4 stations
seeing the same strike for usable accuracy. Bengaluru sits in a
gap where Blitzortung would either miss strikes entirely or
report them with kilometre-scale position errors.

The two-tier coverage we already have is sufficient:

| Tier | Source | Range |
|------|--------|-------|
| Close | AS3935 sensor | ~few km indoors / ~40 km outdoors |
| Regional | Open-Meteo CAPE + weather_code | 5-min poll, 13 km grid |

The mid-range gap (10–80 km, real-time strike-by-strike) that
Blitzortung would have filled isn't actionable for the
auto-disconnect decision (close range is) and isn't a planning
question (regional CAPE is).

Closed in HANDOVER.md as "dropped" rather than deleted, so future-
self can see why we chose not to pursue this. Parser Cases 2/3 are
now permanently dead code in `Parse Strike` — flagged for stripping
in a future flow cleanup pass (low priority; the dead branches
cost nothing at runtime).

---

## 2026-05-13

### Lightning audit — fix silent disconnect regression + 11 follow-up cleanups

Audit pass on the Lightning Antenna Protector flow tab triggered by a
"check if this can be optimised and check all errors" prompt. Found
one **critical regression** introduced yesterday by [`76d60e5`](https://github.com/vu2cpl/shack/commit/76d60e5) (the
distance-graded disconnect commit), plus ten consistency / hygiene
issues worth fixing in one pass.

#### Critical: AS3935 disconnects were silently broken

`Trigger Disconnect` (`d62fb0c3c40f03b7`) yesterday gained a source
filter:

```javascript
if (source !== 'AS3935') {
    node.status({fill:'grey', shape:'ring',
        text:'no-op · ' + source + ' (corroboration only)'});
    return null;
}
```

But `AS3935 Threshold Check` (`ad80b86a672a9ec6`) sets
`msg.strike.source = 'AS3935 (local)'` — note the trailing `' (local)'`.
Strict equality `'AS3935 (local)' !== 'AS3935'` is **true**, so every
real AS3935 lightning event was getting early-rejected. The chain
*looked* fine on the dashboard because `AS3935 within threshold?`
(`af1b4512527ffb45`) fan-outs its output-0 to both `Trigger Disconnect`
**and** `AS3935 Disconnect Log` in parallel — so the log + JSONL kept
writing `"DISCONNECT triggered"` lines while the MQTT publish to the
antenna switch was suppressed. Dashboard lied; antenna stayed connected.

Why the 2026-05-12T16:00:06 real-strike disconnect cited in yesterday's
changelog worked anyway: the strike was at 16:00; the regression
commit landed at 16:40. The verification used pre-regression code.

**Fix:** loosened the filter to reject only `Open-Meteo` (the source
that genuinely should never directly fire DC) and let AS3935 / TEST /
any future source fall through the matrix. AS3935-specific detection
moved inside the function via `isAS3935 = source.indexOf('AS3935') !== -1`,
which gates the only AS3935-specific behaviour (pushing into the
sliding `recent_as3935` corroboration window). TEST injects now
exercise the matrix without polluting the corroboration counter — so
clicking "TEST ⚠ 35 km" three times can't manufacture a fake
"2 hits in 5 min" disconnect.

#### Follow-up fixes bundled into the same patch

1. **Removed dead `Within threshold?` switch** (`12c029b533385153`).
   It pre-gated `strike.distance_km <= flow.threshold_km` before
   `Trigger Disconnect`, but the matrix already does its own zone
   filtering (`cfg_close_km` / `cfg_medium_km`). Worse, if the user
   slid `threshold_km` below `cfg_medium_km`, valid medium-zone
   strikes would never reach the matrix. Haversine now wires directly
   to Trigger Disconnect. 76 → 75 nodes (matches the count CLAUDE.md
   already stated — we were briefly at 76).
2. **`AS3935 Disconnect Log` is now bypass-aware.** Previously wrote
   "DISCONNECT triggered" lines into event_log + JSONL even when the
   bypass switch suppressed the actual disconnect (the log wire is
   parallel to `Trigger Disconnect`, not downstream of it). Now reads
   `flow.bypass_active` and writes `"BYPASS · disconnect suppressed"`
   with `event_record.type = 'disconnect_suppressed'` + `bypass: true`
   when in bypass mode. JSONL stays truthful for post-mortem analysis.
3. **Reconnect-timer cancellation from manual paths.** Previously a
   pending reconnect timer could keep running after the user did
   `Manual Override`, `Force Reconnect`, or `POST /lightning/ant-on`
   — firing later and re-toggling the antenna behind the user's back.
   All three nodes now have an extra output wired to `Reconnect Timer`
   with `payload: 'cancel'`. `Manual Override` outputs 1→2, `Force
   Reconnect` outputs 1→2, `HTTP → Antenna ON` outputs 2→3. `HTTP →
   Radio ON` does **not** cancel — the timer governs antenna, not
   radio.
4. **Stripped three `node.warn` debug lines.** `Stats → Dashboard`
   had a leftover 5-line `node.warn` block firing every 30 s into
   the debug sidebar (from filter-persistence debugging on 05-11).
   `Reconnect Timer` had `node.warn('Reconnect Timer FIRED → ...')`.
   `Bypass Handler` had `node.warn('Bypass Handler: action=...')`.
   All three were leftover instrumentation.
5. **Dropped unused `flow.recent`** push from `Haversine Distance`
   — 100-entry rolling list nothing read. The corroboration window
   (`flow.recent_as3935`) is maintained by Trigger Disconnect and
   is the only history any node consumes.
6. **Fixed stale comment in `Parse AS3935`** — `// AS3935 reports 1
   = overhead, 40 = out of range` claimed `40` but the actual sentinel
   the code checks (correctly) is `63` (0x3F). Comment now matches.
7. **Cleaned `Replay AS3935 State` return form.** Was returning
   `[out]` where `out` is an array of payloads (relies on Node-RED's
   fan-out-on-array-output behaviour). Replaced with explicit
   `out.forEach(m => node.send(m)); return null;` — same behaviour,
   reads obviously.

#### What did NOT change

- **Decision matrix logic** — close < 10 km always fires; medium 10–25
  km needs corroboration (2 AS3935 hits in 5 min OR OM lit); far ≥25
  km only fires on OM severe. All seven `cfg_*` keys unchanged.
- **Bypass behaviour** — still early-exits in Trigger Disconnect
  (`flow.bypass_active === true`); still resets on every deploy via
  Init Defaults; still expires after 120 min.
- **Init Defaults clobbering `threshold_km` / `reconnect_min` on
  every deploy** — flagged in the audit but the author's "always
  overwrite from config" comment is intentional. Slider/HTTP changes
  still don't survive a Deploy. Left alone; revisit if it becomes
  irritating.
- **TEST inject button labels vs actual haversine distance** — the
  three test inject buttons' lat/lon coordinates produce distances
  that don't match their labels (e.g. "TEST ⚡ 6 km" actually computes
  to ~23 km from MK83TE). Pre-existing; tangential to this audit.

#### Net node count

Lightning tab: 76 → 75 nodes (one switch deleted). CLAUDE.md flow tab
table line for Lightning Antenna Protector showed 71 — that's been
stale since at least the 2026-05-08 bypass + Shack-tab merge; not
touched in this commit, but worth noting if anyone audits it next.

#### Diagnosis lesson

When a downstream log node fan-outs in parallel with an action node
(rather than being downstream of it), the log will lie if the action
node short-circuits. Two design choices to prevent recurrence:

- Put the disconnect log **downstream** of `Trigger Disconnect`, so
  the log only fires when the disconnect actually fires. Tradeoff:
  loses the "AS3935 hit but matrix said no" log entries which are
  useful for tuning the corroboration thresholds.
- Or keep parallel logs but always read the action-node's state
  (bypass flag, source-filter result) into the log line, so the log
  is honest about what actually happened. This is what (2) above
  implements for bypass.

The matrix-said-no case is now logged truthfully via the
`AS3935 Warn Log` branch of `AS3935 within threshold?` (which fires
when km > threshold) — the existing wiring there was already correct.

#### Files touched

- `flows.json` — 11 function bodies + 3 outputs/wires + 1 switch
  deletion. Diff: +24 / −40 lines.
- `clublog_dxcc_tracker_v7.json` — no change (DXCC tab not touched);
  regen produces identical bytes.

#### REBUILD_PI.md / `rebuild_pi.sh` impact

None — flows.json is git-tracked; Pi just `git pull && sudo systemctl
restart nodered`.

---

### Lightning dashboard: ALL CLEAR boot state replaces "Awaiting first event"

Master Dashboard `ui_template` (`557083037f168b22`) used to render
`⏱ Awaiting first event` in muted grey on first paint and after the
30-second event-recap timeout when no prior alert existed. Operator
preference: the post-relaunch / no-events state should show a positive
`✔ ALL CLEAR` in green, matching the styling used by the `> 50 km`
strike path. Reads as reassuring rather than pending.

Two surgical changes inside the `format` string:

1. **Initial HTML render** — `<div id="alertBox">` now ships with
   inline `background:#0d2818; border-color:#238636;`, `<span
   id="alertIcon">✔</span>`, and `<span id="alertTxt"
   style="color:var(--green);">ALL CLEAR</span>`. Boot state is
   green from the first paint.
2. **`clearAlert()` no-prior-event branch** — the `if (!lastAlert)`
   path now calls `paintAlert('✔','ALL CLEAR','#0d2818','#238636',
   '#3fb950')` instead of `paintAlert('⏱','Awaiting first event',
   '#161b22','#21262d','#8b949e')`. Returning-to-idle after Node-RED
   restart (no `lastAlert` cached) re-paints to green.

The post-first-event recap path (`Last: <text> · Nm ago` in muted
grey) is untouched — that one still kicks in 30 s after every real
strike and continues to refresh its relative-time string every 30 s.

Net: the dashboard reads "all clear" on every relaunch, then if a
strike fires it goes red/amber/green per zone for 30 s, then settles
into a muted recap line for the rest of the session.

#### Files touched

- `flows.json` — 1 ui_template `format` field; 1 insertion, 1
  deletion (the HTML block became a one-line replacement inside the
  big format string).
- No node count change.
- DXCC tab untouched; extract bytes-identical.

Pre-flight audit for making `vu2cpl-shack` public. Five fixes applied:

**1. Removed hardcoded Club Log API key.** `Build cty.xml URL`
function had a literal `7cc2e40298a9da3f173bd06118f6cb08cc3131f3` as
fallback when `flow.get('cfg_cl_apikey')` returned empty. Defeated the
entire env-vars-via-systemd pattern the rest of the secrets follow.
Replaced with `|| ''`. **Operator must rotate the key on Club Log
side** — it's been in `origin/main` history for some time, public-OK
only if rotated.

**2. Telegram chat ID externalised.** Was inline as
`tg_chat_id: '784711092'` in the Credentials node. Not a secret in
the cryptographic sense (the bot token is what matters, and that's
already env'd), but it does identify the operator's personal Telegram
chat. Moved to `env.get('TELEGRAM_CHAT_ID')` for consistency with the
other three credential keys. Pi-side needs a new line in
`/etc/systemd/system/nodered.service.d/secrets.conf`:

```
Environment="TELEGRAM_CHAT_ID=784711092"
```

`REBUILD_PI.md` Step 10 updated to include this env var in its
`secrets.conf` template.

**3-4. Untracked two runtime data files.** `git rm --cached` for
`nr_dxcc_seed.json` (306 KB, full per-band/per-mode worked-DXCC matrix,
auto-refreshed daily by the Club Log fetch cron) and
`nr_dxcc_blacklist.json` (operator's per-callsign mute list — small
but socially-revealing in a public repo). Files stay on disk; the
daily fetch repopulates the seed after any `git clone` + first cron
tick. Blacklist starts empty on a fresh clone and gets populated by
the `POST /dxcc/blacklist-add` HTTP endpoint as needed.

**5. `.gitignore` expanded** from one line (`*.backup`) to cover:

```
*.backup
.DS_Store
.claude/
nr_dxcc_seed.json
nr_dxcc_blacklist.json
nr_lightning_events.jsonl
```

The last one is the JSONL historic store we added today — runtime
data, not source-controlled.

**Audit findings deliberately NOT changed:**

- **LAN IPs** (`192.168.1.148/158/169/170/241`) stay hardcoded.
  RFC1918, no external risk, and most ham-shack repos ship their LAN
  IPs so forkers see the structure. Genericising would touch dozens
  of nodes in flows.json + four .md files for low payoff.
- **Email address** (`vu2cpl@gmail.com` in the Credentials node)
  stays — already in CLAUDE.md and on every QSL card. Same applies
  to the callsign, grid, and DXpedition history.
- **MQTT broker is plain / no-auth** (`192.168.1.169:1883`) — LAN-only,
  documented as such. Anyone inside the LAN could already see it.

**Git history pollution** — even after this scrub, the literal API
key + chat ID sit in past commits. Accepting that; the key rotation
makes the historical disclosure dead. `git filter-repo` to rewrite
history would be overkill for a hobby repo with hardware-side
secondary auth (the broker is LAN-only, the bot token is env'd, the
API key will be rotated).

**Sequence on the Pi to deploy:**

```sh
# 1. Add the new env var to secrets.conf:
sudo nano /etc/systemd/system/nodered.service.d/secrets.conf
# Add: Environment="TELEGRAM_CHAT_ID=784711092"
# Also update CLUBLOG_API_KEY to the freshly-rotated value.

# 2. Pull + restart:
cd ~/.node-red/projects/vu2cpl-shack
git pull
sudo systemctl restart nodered

# 3. Sanity-check Credentials node status badge in editor:
#    should show: "Config loaded: VU2CPL-1 / tg:784711092"
#    (anything red means an env var is missing)
```

**Then it's safe to flip the GitHub repo Settings → Visibility →
Public.**

---

### Lightning: historic event store — strikes + actions persisted to JSONL

`flow.event_log` is great for the dashboard's snappy Event Log card but
it's in-memory, capped at 50 rows, and wipes on every deploy. Operator
wanted a long-running record for post-storm analysis, false-positive
trend tracking, and general "what happened on the night of …" recall.

**Design (C2 — separated concerns):**

- Dashboard keeps its in-memory `flow.event_log` exactly as before
  (50 rows, fast, no I/O on the render path).
- A new function node **`Append Lightning JSONL`** ([`bf480be`](https://github.com/vu2cpl/vu2cpl-shack/commit/bf480be))
  appends one JSON-Lines row per event to
  `/home/vu2cpl/.node-red/projects/vu2cpl-shack/nr_lightning_events.jsonl`.
  Append-only, no read-modify-write race, grows unbounded (logrotate
  when it gets big).
- File path is set by `Init Defaults` on every deploy as
  `cfg_events_jsonl` so the append function reads it from flow context.

**Coverage** (in two waves):

1. **First wave** (`bf480be`) — the three existing log-writer functions
   (`Format Log`, `AS3935 Warn Log`, `AS3935 Disconnect Log`) each now
   also emit `msg.event_record = {ts, source, type, km, energy, …}`
   alongside their existing dashboard output, and have a parallel wire
   to the new append node. Captures: disconnects, reconnects, manual
   overrides, AS3935 below-threshold warnings, AS3935 above-threshold
   disconnects.

2. **Second wave** (`a93a1e3`) — operator noticed a pre-existing gap:
   above-threshold OM strikes and TEST injects above the 25 km
   disconnect threshold silently drop at the `Within threshold?`
   switch (single-output `lte` rule, anything `>` just falls off the
   end). Added a third tap, `Log all strikes (to JSONL)`, hanging off
   `Haversine Distance`'s output as a 3rd parallel target. Now every
   strike — AS3935 / Open-Meteo / TEST — gets a `type:"strike"` JSONL
   row regardless of whether it triggers a disconnect.

The two waves emit different `type` values intentionally — `"strike"`
captures the inbound event, `"disconnect"` / `"reconnect"` / `"warn"`
capture the action. Both arrive for events that fire the chain (one
strike, one action), only the strike row arrives for events that
don't. Plenty of data for jq-side analysis.

**Two bugs hit during bring-up — instructive enough to record:**

| Bug | Symptom | Cause | Fix |
|-----|---------|-------|-----|
| Init Defaults silently broken | `Append Lightning JSONL` warned "cfg_events_jsonl not set" every event; file never created | `os.homedir() + …` threw `ReferenceError: os is not defined` at line 83 of Init Defaults — `os` is **not** a free global in Node-RED function nodes unless the node's `libs:` array declares it. DXCC functions all have `libs: [{var:'os', module:'os'}, …]`; Init Defaults didn't. | Hardcoded `/home/vu2cpl/.node-red/projects/vu2cpl-shack` ([`784a634`](https://github.com/vu2cpl/vu2cpl-shack/commit/784a634)) — this Pi only |
| Append node also broken | `JSONL append failed: fs is not defined` once Init Defaults was fixed | Same root cause one layer down: `Append Lightning JSONL` referenced `fs.appendFileSync` without a `libs:` declaration. | Added `libs: [{var:'fs', module:'fs'}]` to the new function node ([`c8fbcb4`](https://github.com/vu2cpl/vu2cpl-shack/commit/c8fbcb4)) |

**Mental model worth pinning** (recording so future-self stops
re-learning this):

> In Node-RED 1.3+ function nodes, `fs` / `os` / `path` / `https` /
> etc. are **per-node libs**, not project-wide globals. If a function
> uses one of them, its node config must include
> `libs: [{var:"<name>", module:"<module>"}]`. Symptom of a missing
> declaration is `ReferenceError: <name> is not defined` from the
> first line that references it. Audit existing nodes via
> `grep -l "libs.*[\"']fs[\"']"` in flows.json before assuming a name
> is available.

**Test injects gained `source:"TEST"`** ([`20d0b16`](https://github.com/vu2cpl/vu2cpl-shack/commit/20d0b16)) —
the three test injects (`6 km DISCONNECT`, `35 km warning`,
`120 km safe`) previously had no `source` field in their payload, so
JSONL rows came out as `source:"unknown"`. Added `"source":"TEST"` to
each so analysis filters can cleanly separate test from real:

```sh
# real events only
jq -c 'select(.source != "TEST")' nr_lightning_events.jsonl
# test events only
jq -c 'select(.source == "TEST")' nr_lightning_events.jsonl
```

Once trusted, the `Log all strikes` function has a commented
"suppress TEST entries from JSONL" guard that can be uncommented to
stop polluting the historic record with bench tests.

**Deferred** (operator's call): Open-Meteo 5-min poll cadence rows and
Bypass switch on/off events are not yet captured — both are
small-volume / high-value adds. Disturber / noise from AS3935 not
captured either (high-volume — would 10× the file size with an
indoor sensor; deferred until either someone wants the data, or the
sensor moves outdoors and disturber rate drops).

**REBUILD_PI.md impact:** none. `jq` is already in Step 2's
`apt install` list — this Pi predates the runbook and needed a
one-time `sudo apt install -y jq` separately, but a fresh rebuild
gets it. `nr_lightning_events.jsonl` is runtime data (like
`nr_dxcc_seed.json`); not in `.gitignore` but `nrsave` only stages
`flows.json` so it doesn't accidentally land in a commit.

---

### SPE: stale-state lying fix — gateway-side presence-heartbeat + panel offline-wipe

Operator noticed the Node-RED SPE panel + Macexpert SPE app both kept
showing the last-known amp state after physically powering the amp
off — only a fresh page-load / WS reconnect picked up the truth.
Identical symptom across two independent clients, so the bug had to be
on the gateway. Multi-hour debug session, fixed in two commits on the
[`vu2cpl/spe-remote`](https://github.com/vu2cpl/spe-remote) repo plus
several follow-on Node-RED panel changes here.

**Diagnosed root cause** (in `spe-remote/spe/websocket_handler.py` +
`spe/serial_handler.py`): `broadcast_state` only fires when
`SerialHandler.on_state_update` calls it, which only fires when serial
frames arrive and parse cleanly. When the amp powers off, no frames →
no broadcast → connected clients never learn the amp went down.
Macexpert's defence was to reconnect every 5 s on silence — visible in
`journalctl -u spe-remote` as continuous connect/disconnect spam, each
fresh client just refetching the same stale snapshot.

**Gateway fix** (cross-ref [`spe-remote@248b922`](https://github.com/vu2cpl/spe-remote/commit/248b922)
and [`spe-remote@ab6d94d`](https://github.com/vu2cpl/spe-remote/commit/ab6d94d)):

- New asyncio task `presence_heartbeat_loop` emits
  `{"heartbeat": true, "serial": "up"|"down", "ts": ..., "clients": …}`
  every `polling.presence_heartbeat` seconds (default 5).
- `serial` is **amp liveness**, not USB-FTDI link state. The SPE
  Expert 1.5 KFA's FTDI cable is USB-powered from the Pi end — the
  link stays open even when the amp's CPU is fully off. Real signal:
  SerialHandler now tracks `_last_state_at` (monotonic timestamp of
  last successful CSV parse); `serial: "up"` iff `last_state_age <
  polling.amp_alive_threshold` (default 3 s).
- New `AmplifierWebSocket.broadcast_raw` classmethod bypasses the
  state-dedup gate so heartbeat cadence is exact.
- Worst-case amp-off detection latency: 5 + 3 = 8 s.
- Wire-compatible: existing state / power_result / RCU paths
  unchanged. The Node-RED `Parse + route` function already dispatched
  on `d.heartbeat` and `d.serial === "up"` — those keys finally exist.

**Panel-side follow-ups in this repo** — drag the dashboard into
parity with the new gateway truth:

1. **Single state-aware Power button**
   ([`b6640ea`](https://github.com/vu2cpl/vu2cpl-shack/commit/b6640ea))
   — replaced the separate `Power Off` (primary row) and `Power On`
   (buried in "More Details") buttons with one toggle at the top of
   the panel. Green `ON` when amp alive, red `OFF` otherwise. Click
   confirms then publishes `OFF_SPE` (→ existing WS `power_off`) or
   `ON_SPE` (→ new exec node running `python3 /home/vu2cpl/power_spe_on.py`
   — WS `power_on` can't wake an amp whose CPU is fully off). Router
   gained a 2nd output for the script path.
2. **Wipe stale state to em-dash when amp goes offline**
   ([`86d4b1b`](https://github.com/vu2cpl/vu2cpl-shack/commit/86d4b1b))
   — when `d.usb` flips false, every cached field (Mode / RX-TX /
   Band / Input / TX Ant / PWR Lvl / Warnings / Alarms / V PA / I PA
   / all Temps / Bank / RX Ant / Model / both SWR values) drops to
   `—`, and all three bars reset to 0%. Real state msgs flow on
   amp-return and repopulate every field via existing per-field
   handlers — no "re-enable" logic needed. Panel stops lying.
3. **Output Power gets a numeric readout** ([`2585b25`](https://github.com/vu2cpl/vu2cpl-shack/commit/2585b25),
   reformatted in [`652f033`](https://github.com/vu2cpl/vu2cpl-shack/commit/652f033))
   — previously the row had only a bar fill + a small "(scale …W)"
   sublabel. Now matches the SWR rows: label on the left, live
   `247/500W` value on the right (actual / current band-max), bar
   underneath. Same threshold colouring (green / amber / red at 70 /
   90 % of band-max).

**Hard-earned debug lesson** — `scope` inside a Node-RED dashboard 1.x
`ui_template` inline `<script>` is a **transient** top-level reference,
not a free closure variable. Code at the top level of the script can
call `scope.$watch(…)` immediately, but functions defined there that
**later** reference `scope` (e.g. button handlers) silently break in
Safari with `ReferenceError: can't find variable: scope`. We chased
three wrong fixes (ng-click scope routing → `addEventListener` on the
button → `onclick="window.X()"`) before the Safari console finally
spelled out the failure. The working pattern (now confirmed in two
panels — chrony card + AS3935 Control Panel — plus the SPE panel here):

```js
// 'scope' at top level is transient. Capture it via IIFE parameter
// for any function that fires later (button handlers, async
// callbacks, etc.).
(function(scope){
  window.speAmpToggle = function(){
    /* … uses scope.send(…) here … */
  };
})(scope);
```

Recorded in this changelog so future-self stops re-discovering it.

**Other notes:**
- Macexpert SPE app reconnect-on-5-s-silence loop should be replaced
  with reconnect-on-30-s-of-nothing once the Mac-side update lands.
  Standalone debug-handover written into the Macexpert SPE repo on
  the same date covers what the Mac client needs to consume.
- Pi `git pull` in `spe-remote` always needs a stash dance because
  the live `temperature_unit` toggle writes back to `config.yaml` at
  runtime. Worth flagging in that repo's `handover.md` (already done
  in the entries pasted from this session).

**No REBUILD_PI.md / `rebuild_pi.sh` impact** — `spe-remote` isn't
installed by either; it's a separate project with its own install
lineage. Flows.json changes flow through `git clone` automatically.
DXCC tab extract regenerated per rule #4 (no diff — DXCC tab not
touched).

---

## 2026-05-12

### Lightning protection: distance-graded disconnect + AS3935 runtime cmd channel

Big day. Two related changes landed, plus a runtime control surface for
the ESP32 sensor bridge:

#### 1. Decision matrix — `Trigger Disconnect` now grades by zone × OM state

`Trigger Disconnect` (`d62fb0c3c40f03b7`) used to fire unconditionally on
any strike that passed the upstream threshold switch — regardless of
source, regardless of corroboration. With Open-Meteo synthesising a
0 km "strike" on any current-hour `weather_code ∈ {95, 96, 99}` and a
10 km "strike" on any CAPE ≥ 2500, the chain was firing
preemptively on high-CAPE-no-storm days. Conservative, but noisy.

New logic: AS3935 lightning events drive the chain; OM is a probability /
severity signal that modulates the corroboration threshold per zone.
**Open-Meteo never directly fires the disconnect** anymore.

**Decision matrix:**

| OM state | AS3935 close (<10 km) | AS3935 medium (10–25 km) | AS3935 far (≥25 km) |
|----------|------------------------|---------------------------|----------------------|
| **cold**   | single hit → DC | 2 hits in 5 min → DC, else log only | log only |
| **lit**    | single hit → DC | single hit → DC (corroborated) | log only |
| **severe** | single hit → DC | single hit → DC | single hit → DC |

**OM state derivation** (computed every 5-min poll in `Parse Open-Meteo → Strike`):

| OM state | Condition |
|----------|-----------|
| cold   | CAPE < `cfg_om_cape_thresh` (default 800 J/kg) OR wmo ∉ {95, 96, 99} |
| lit    | CAPE ≥ 800 AND wmo ∈ {95, 96, 99} |
| severe | CAPE ≥ `cfg_om_cape_severe_thresh` (default 2500 J/kg) AND wmo ∈ {95, 96, 99} |

State persists `cfg_om_lit_window_min` (default 20 min) after each poll, so a
transient calm-CAPE reading mid-storm doesn't immediately drop OM back to cold.

**Invariants** chosen deliberately during planning:

- **Close zone always fires on single hit.** The user accepted the trade-off:
  this means single misclassified-disturber-as-lightning events at distance 1 km
  still trigger DC. Cost of a false positive (≤20 min radio offline) ≪ cost
  of missing a real close strike (FlexRadio + SPE + antennas exposed).
- **OM alone never disconnects.** Even with `severe` state, if AS3935 has
  seen nothing, no DC fires. OM is pure probability — it can amplify trust
  in an AS3935 hit but cannot manufacture one.
- **Disturber events don't feed the chain.** Only `lightning`-typed AS3935
  events go through `Trigger Disconnect`; disturbers still increment
  counters and log for diagnostics.

**Config keys (all live-tunable from `Init Defaults`):**

```
cfg_close_km              = 10    // AS3935 close-zone radius (km)
cfg_medium_km             = 25    // AS3935 medium-zone radius (km)
cfg_med_window_min        = 5     // sliding strike window
cfg_med_count             = 2     // hits in window for OM-cold medium DC
cfg_om_lit_window_min     = 20    // OM state persistence
cfg_om_cape_thresh        = 800   // "lit" CAPE threshold
cfg_om_cape_severe_thresh = 2500  // "severe" CAPE threshold
```

Strike history lives in `flow.recent_as3935 = [{ts, km}, …]`, trimmed
to the sliding window on every call. Reset on every `Init Defaults`
run (deploy / restart).

**Implementation** ([`76d60e5`](https://github.com/vu2cpl/vu2cpl-shack/commit/76d60e5)):
three function-body changes, no wire changes.
- `Init Defaults` (`ec1fd4dece8c4dc0`) — 7 new cfg keys + `recent_as3935`/`om_state` reset.
- `Parse Open-Meteo → Strike` (`593f22a507b46335`) — derive OM state from
  CAPE + wmo; persist with TTL. Strike-emission path (Output 1) kept intact
  for dashboard / event log compatibility — the actual filter happens
  downstream.
- `Trigger Disconnect` (`d62fb0c3c40f03b7`) — full rewrite. Source filter,
  matrix decision, sliding history. Status badge now reports the decision
  (`close 6km`, `medium 18km · uncorroborated`, `far 30km · OM severe`, …)
  for live observability.

**Net behaviour shift vs pre-today:** OM-only DCs stop happening
(today's pain). Single-AS3935-hit medium-zone DCs only happen when
OM agrees there's a storm. Far-zone hits log unless OM is severe.

#### 2. AS3935 ESP32 bridge — v0.2.0 cmd channel (firmware repo)

Operator built v0.2.0 of [`vu2cpl-as3935-bridge`](https://github.com/vu2cpl/vu2cpl-as3935-bridge)
firmware between yesterday's bench bring-up (v0.1.1) and this morning.
v0.2.0 adds runtime tunability of every AS3935 register field over MQTT,
NVS persistence, and an on-device port of `as3935_tune.py`'s TUN_CAP sweep.

**New MQTT topics:**

| Topic | Direction | Payload |
|-------|-----------|---------|
| `lightning/as3935/cmd`     | Node-RED → ESP32 | `{"set": "<key>", "value": …}` or `{"action": "<name>"}` |
| `lightning/as3935/cmd/ack` | ESP32 → Node-RED | `{"ok": bool, "cmd": "set:<key>"\|"action:<name>", "ts": "..."}` (not retained) |
| `lightning/as3935/status`  | ESP32 → Node-RED | retained; republished after every successful set/action so subscribers see fresh state |

**Tunables** (NVS-backed, range-validated):
`nf` (0–7) · `wdth` (0–15) · `srej` (0–15) · `tun_cap` (0–15) ·
`mask_dist` (bool) · `min_num_lightning` (1|5|9|16) ·
`afe_gb` (`"indoor"`/`"outdoor"`) · `modem_sleep` (`"max"`/`"min"`).

**Actions:** `republish_status` · `calibrate_tun_cap` (~35 s sweep, MQTT
keepalive pumped inside the loop) · `reboot` · `factory_reset_wifi`.

Full HANDOVER entry drafted in this session; pasteable into
`vu2cpl-as3935-bridge/HANDOVER.md` separately when the operator gets
to it.

#### 3. AS3935 Control Panel — runtime tunables on the shack dashboard

A self-contained admin panel for the v0.2.0 cmd channel, living on its
own flow tab (`AS3935 Tuning`, id `fe70cfdcdfa19aa4`) and its own
dashboard group (`as3935_ctl_grp`). Three mqtt-in nodes (status / hb /
cmd/ack) feed a single `ui_template`; ui_template's output wires to a
single mqtt-out publishing to `lightning/as3935/cmd`. All UI logic and
formatting lives inside the template.

Visual design follows the GitHub-dark conventions used by the chrony
card and Master Dashboard: `--bg #0d1117`, `--card #161b22`,
`--border #30363d`, `--green #3fb950`, `--amber #e3b341`, `--red #f85149`;
LED indicator dots inside status chips; 8 px rounded card corners.

**Rows shipped today:**
- LED + title + meta (FW · IP · RSSI · uptime)
- Counters (⚡ disturber 📡 IRQ)
- Calib (TRCO · SRCO)
- **Tunables** (NF / WDTH / SREJ / TUN_CAP nudgeable; Mask dist toggleable;
  **AFE GB toggleable** [`cf6816f`](https://github.com/vu2cpl/vu2cpl-shack/commit/cf6816f) / [`80a8b40`](https://github.com/vu2cpl/vu2cpl-shack/commit/80a8b40);
  Min strikes / Modem sleep dropdowns)
- Actions (Calibrate TUN_CAP · Republish · Reboot · Factory Reset WiFi)
- Command log (last ack)

**One nontrivial bug hit and fixed during bring-up** ([`7d205c1`](https://github.com/vu2cpl/vu2cpl-shack/commit/7d205c1)):
The template's IIFE wrapper had been refactored to `(function(){…})()`
with no `scope` binding. Inside the IIFE, `scope.$watch` and `scope.send`
both reference an undeclared `scope` — the IIFE silently threw a
ReferenceError on first run. Heartbeat counters appeared to update only
because of cached DOM from a prior working deploy; status never
populated, buttons silently dropped clicks. Fix was a two-token change
to **Pattern B** (matching the chrony card): `(function(scope){…})(scope)`.
The outer `scope` reads from node-red-dashboard's script-wrapper closure
where it IS available; the IIFE captures it as a parameter. Restored the
`var scope = this;` alternative (Pattern A, used by the original
panel and Master Dashboard) was also viable; Pattern B chosen because
it's explicit + matches a known-good newer template.

**Cosmetic cleanup** ([`00f4270`](https://github.com/vu2cpl/vu2cpl-shack/commit/00f4270)):
- Header meta line (FW / IP / RSSI / uptime) recoloured from `--muted`
  to `--text` (white) — more readable, matches the body text below it.
- Calib row trimmed to `TRCO=… · SRCO=…`; the `· afe_gb=…` segment
  removed (now a dedicated row in Tunables, deduplicated).

#### 4. Side-quest: rollback-tab pattern

Worth recording as a Node-RED pattern. During v0.2.0 panel development
([`f88e965`](https://github.com/vu2cpl/vu2cpl-shack/commit/f88e965))
the operator imported a fresh clone of the AS3935 control flow onto a
brand-new tab id, disabled the **original** tab as single-toggle rollback
insurance, deployed. With the new copy verified working, the original
disabled tab was deleted on 2026-05-12. Note for the future:

- A disabled flow tab still consumes node IDs and counts toward the flow
  file's bulk; safe to keep short-term, plan to clean up.
- Two ui_templates with the same `group` ID render into the same dashboard
  group. Even when the source tab is disabled, the dashboard runtime in
  node-red-dashboard 1.x may not cleanly stop the disabled instance from
  participating in group registration — observed-but-uncertain
  sluggishness while both copies were live. Deleting the disabled tab
  outright (not just `disabled:true`) is the reliable fix.

#### 5. Post-map-ripout cleanup ([`f043a4d`](https://github.com/vu2cpl/vu2cpl-shack/commit/f043a4d))

Spotted while re-reading the Lightning tab for the distance-graded work:
an inject node "Clear map every 30 min" (id `55f94d9dde0dc893`) still
firing every 1800 s. The map it referred to was ripped out on 2026-05-08
([HANDOVER 05-08 entry](#)). The trigger wasn't fully dead though — its
downstream `clear all` function was still wiping `flow.event_log` every
30 min, just under a stale name. Other state it cleared
(`last_strike_km` for the removed gauge, legacy `strikes` array for the
removed map dots) had no consumers anymore.

Tightened up:

- Renamed inject to `Clear event log every 24 h`.
- Stretched repeat from 1800 s (30 min) to 86400 s (24 h) — event-log
  rotation goes from aggressive to daily.
- Dropped the two dead `flow.set` lines from `clear all`; only the
  `event_log = []` + `{type:'clear'}` emit to Master Dashboard remain.

3 lines changed in flows.json; behaviour now matches the label.

#### Other ops notes from today

- Real lightning fired at AS3935 distance 1 km mid-session (`energy 219990`,
  `timestamp 2026-05-12T16:00:06`), 56 disturbers in the previous 4 min
  prior. Disconnect chain fired correctly per the close-zone rule.
- Indoor noise floor remains high; ESP32-outdoor-install (HANDOVER #1)
  is the path to material false-positive reduction. The graded matrix
  helps medium / far zones; close zone false positives remain inherent
  until the sensor relocates outside.

**REBUILD_PI.md impact:** none. All changes are inside `flows.json` —
a fresh rebuild clones the repo and gets the new logic automatically.

---

### Chrony status card: GitHub-dark palette + vanilla JS DOM ([`d9d57e8`](https://github.com/vu2cpl/vu2cpl-shack/commit/d9d57e8))

Brought the GPS NTP chrony card in line with the rest of the
dashboard's GitHub-dark conventions. The old card used a custom
teal-on-near-black palette (`#5cd0d6` teal section labels, `#0e151e`
background, `#e89a4a` orange attention, etc.) that stood out
distractingly next to everything else on `/ui`. New palette pins
to the shared tokens:

| Token | Value | Used for |
|-------|-------|----------|
| `--bg`     | `#0d1117` | page bg |
| `--card`   | `#161b22` | card surface |
| `--border` | `#30363d` | outlines + row dividers |
| `--green`  | `#3fb950` | good (PPS, stratum 1, 3D fix) |
| `--amber`  | `#e3b341` | attention threshold + warn chips |
| `--red`    | `#f85149` | bad (no fix, stratum bad) |

**Other changes folded into the same retheme:**

- **Rendering switched** from AngularJS interpolation
  (`{{data.foo}}` + `ng-class`) to vanilla JS DOM (`getElementById`
  + `classList`, driven by `scope.$watch('msg', …)`). Matches the
  convention used by other custom widgets across this dashboard;
  avoids the whole-card re-render that AngularJS bindings trigger
  on each `scope.data` assignment.
- **Status chips gained color-coded LED dots** (8 px round + a
  `box-shadow:0 0 4px currentColor` glow). Quick visual triage at a
  glance — green LED for PPS/stratum 1/3D fix, amber for degraded,
  red for no fix.
- **Hosting `ui_group` flipped** to `disp: false` (the template
  carries its own title) and `width: 10` (was width 6 inside the
  general Network Monitor group).

**Pi-side workflow:** [`pi-gps-ntp-server@6e54f14`](https://github.com/vu2cpl/pi-gps-ntp-server/commit/6e54f14)
landed the canonical template + README upgrade guide + matching
preview HTML upstream. Operator then opened the live
`Chrony status card` ui_template in the Node-RED editor, pasted
the new template body, flipped the `ui_group` properties, Deployed,
and `nrsave`d. That commit is the merge here. `nrsave` (now a
function — closes HANDOVER #17) handled the DXCC tab extract
re-gen automatically; extract was a no-op since the DXCC tab
wasn't touched, so the commit is flows.json-only.

CLAUDE.md's "Chrony / GPS Time Server card (gpsntp.local)" section
updated: architecture note now reflects vanilla-JS-DOM + the
palette + the `disp:false`/width-10 ui_group config; attention
thresholds row clarified that the value text renders **amber**
(`#e3b341`) not orange when crossed.

---

## 2026-05-11

### AS3935 publisher: ESP32 bridge takes over from Pi daemon (same day bench bring-up)

After this morning's planning conversation (recorded in HANDOVER #21
+ the scaffold for [`vu2cpl-as3935-bridge`](https://github.com/vu2cpl/vu2cpl-as3935-bridge)),
the operator wired the ESP-WROOM-32 + AS3935 on a breadboard and got
firmware v0.1.1 publishing live the same evening. Key bench results:

- `TRCO=OK`, `SRCO=OK` after `CALIB_RCO` — internal oscillators
  calibrated cleanly.
- I²C link solid at address `0x03`.
- MQTT pipe live to `192.168.1.169:1883` — retained `status` lands
  immediately on connect, `hb` ticks every 30 s, retained status
  auto-refreshes every 5 min.
- WiFi credentials now via WiFiManager captive portal
  (`vu2cpl-as3935-setup` / `vu2cpl1234` AP on first boot — no
  `secrets.h` to bake into firmware).
- End-to-end verified: piezo-lighter sparks produce
  `event:"disturber"` events on `lightning/as3935`. Counters
  increment. Node-RED Lightning Antenna Protector flow consumed
  everything without a single config change — the goal of the
  contract-identical design.
- Indoor Pi daemon `as3935.service` on `noderedpi4` **stopped and
  disabled**. ESP32 is the sole publisher on `lightning/as3935/*`.

**Reflected in this repo (vu2cpl-shack):**

- **REBUILD_PI.md Step 7** — no longer enables `as3935.service` on
  rebuild. Pi daemon stays installed (files in `/home/vu2cpl/` and
  `/etc/systemd/system/`) but disabled by default. If the ESP32 ever
  fails, `sudo systemctl enable --now as3935` resurrects the Pi as
  publisher. Enabling both at once would race the MQTT topic and
  corrupt retained status — added a row in the failure-modes table
  for that.
- **REBUILD_PI.md Step 12 verification row #6** — reworded to "AS3935
  publishing (from ESP32 bridge)"; still asserts the same
  `lightning/as3935/hb` topic ticks every 30 s, just from a different
  publisher.
- **`rebuild_pi.sh` Stage 9** — `enable --now as3935 rpi-agent` →
  `enable --now rpi-agent` only. Stage 13 verification drops the
  `systemctl is-active --quiet as3935` check (the `lightning/as3935/hb`
  topic check below it covers the actual operational signal). Bash
  syntax-checked.
- **CLAUDE.md Pi-side scripts table** — `as3935_mqtt.py` and
  `as3935.service` rows now annotated as standby fallback.
- **README.md** — Lightning Antenna Protector subsystem description
  updated; hardware table row updated; file-tree comments updated.
- **HANDOVER.md "Current system state"** — AS3935 row reflects ESP32
  primary, Pi daemon disabled.
- **HANDOVER.md #1** (AS3935 outdoors) — still open; the physical
  outdoor install (enclosure, power chain, shade mount, post-install
  TUN_CAP re-tune) remains. Annotated with the bench milestone.
- **HANDOVER.md #21** — updated from "planning" to "v0.1.1 live on
  bench, indoor daemon retired". Lists v0.2.0+ open items (on-device
  TUN_CAP cal mode, power chain, enclosure, field install).

**No `flows.json` change.** The MQTT-contract-identical design paid
off — Node-RED keeps consuming `lightning/as3935`,
`lightning/as3935/status`, `lightning/as3935/hb`, `lightning/as3935/lwt`
exactly as before, just from a different publisher.

---

### HANDOVER #10 (gpsntp + TX RFI watch): closed — no issue at 1 kW

When `gpsntp.local` was first deployed (2026-05-09) with its QLG1
patch antenna tapped off the U3S's 6-way header, the obvious risk
was RFI desensitisation of the GPS during shack transmissions —
the QLG1 sits physically next to the U3S WSPR TX, and a stratum-1
NTP server losing fix during a transmission is the kind of bug
that takes a week of watching to catch.

Operator verified today that `gpsntp` holds stratum-1 PPS lock
through full **1 kW** SPE amplifier transmissions — well above the
~200 mW WSPR level the original watch was designed against. If
1 kW doesn't move the needle, the U3S certainly won't either.

Dedicated NEO-M8N + antenna fallback (documented in
`pi-gps-ntp-server/HANDOVER.md` as the planned recovery path)
remains unused and parked.

---

### CLAUDE.md TODO #1 (AetherSDR MQTT bug): closed — upstream fix shipped

Tracked at [ten9876/AetherSDR#1348](https://github.com/ten9876/AetherSDR/issues/1348)
— "MQTT: 'Connect failed: Socket is not connected' on plain port
1883 with TLS off (macOS)". Reported against AetherSDR v0.8.11
with the exact symptom Manoj hit (TCP SYN → SYN-ACK from the Pi
broker → immediate RST from the Mac client, repeating every 4-5 s
without ever reaching the MQTT handshake — Mosquitto logs zero
connection attempts).

Root cause was a macOS-specific bug in the bundled libmosquitto's
non-blocking connect + immediate packet write path. Fixed in
[PR #1349](https://github.com/ten9876/AetherSDR/pull/1349), merged
2026-04-15 and shipped in [v0.8.15](https://github.com/ten9876/AetherSDR/releases/tag/v0.8.15)
~25 minutes after the merge ("Fix MQTT macOS connection failure"
in the changelog). Subsequent MQTT polish landed across v0.8.15.1,
v0.8.16 (proper TLS with OpenSSL 3.5+), and the 0.9.x line. The
project switched from semver to CalVer today; current release is
[v26.5.1](https://github.com/ten9876/AetherSDR/releases/tag/v26.5.1).

**Mac-side action (separate from this repo):** upgrade AetherSDR
on the Mac Mini to v26.5.1, re-test MQTT to `192.168.1.169:1883`
with TLS off. If it connects clean, the loop is closed; if it
still fails, file a fresh issue with current tcpdump against
v26.5.1.

---

### CLAUDE.md TODO #5 (website uploads): closed as already done

Stale carryover. `~/projects/vu2cpl.github.io/` already carried
all referenced assets — `shack-desk.jpg`, `shack-workbench.jpg`,
`vu7ms_writeup.pdf`, `vu7t_writeup.pdf` — committed and in sync
with `origin/main`; `index.html` correctly references them. The
TODO had said `shack.jpg` singular; the page design evolved to a
two-image gallery (desk + workbench). No further action.

---

### DXCC TODOs #7 + #8: closed as no-action (already done / already covered)

End-of-day audit pass on the two remaining DXCC backlog items.

**TODO #7 — Separate CW/Ph/Data fetch modes.** Already in place.
`Build Club Log API Request` (`6e60f619acad462e`) constructs four
URLs (`mode=0` all-modes, `mode=1` CW, `mode=2` Phone, `mode=3`
Data) and the active `Fetch All Modes + Parse lotw only`
(`aa7434df62b95ebc`) runs all four in parallel via
`Promise.all([fetchURL(m0), fetchURL(m1), fetchURL(m2), fetchURL(m3)])`,
parsing each into ew0/ew1/ew2/ew3 and composing `dxccModeWorked`
as `{adif: {cw:bool, phone:bool, data:bool}}` consumed by the
`NEW_MODE` classifier. Likely the TODO predates this
implementation. (The legacy `Fetch All Modes + Parse` variant
with `bands[mk]>=2 = confirmed` is disabled; the live LoTW-only
variant uses strict `===2`.)

**TODO #8 — Non-project folder path support.** Already covered by
a fallback. Both Fetch functions read
`var flowsDir = flow.get('cfg_flows_dir') || os.homedir() + '/.node-red';`
— if `cfg_flows_dir` is empty (Projects feature not enabled), the
default `~/.node-red/` kicks in. VU2CPL uses Projects so the
fallback never fires here, but the defensive code is present for
operators who fork the flow into a non-Projects setup.

No code change. CLAUDE.md rows reworded to closed-no-action.

---

### DXCC: filter persistence end-to-end (closes CLAUDE.md TODO #6)

Filter chip state on the DXCC dashboard + the spot TTL slider now
survive a Node-RED restart. Verified live: toggled `● MODE` off,
restarted nodered, fired the `TEST XE2ABC 20M SSB (new mode)` inject
— the `DXCC Prefix Lookup + Alert Classify` node correctly dropped
it (no alert table row, no Telegram). Re-enabled `● MODE`, fired
the same inject — alert appeared.

**Root cause was deeper than the surface bug.** Investigation
turned up that `Save Alert Filters HTTP` writes filter state with
`flow.set('filterX', val, 'file')` but every reader across the tab
(`DXCC Prefix Lookup`, `Format Alert for Dashboard Table`, the two
`Format Telegram Alert*` functions, `Format FlexRadio Spot
Command`) reads with `flow.get('filterX')` — no scope arg = default
(memory). That alone would mean reads never see writes. **But** the
`'file'` context store wasn't actually configured on this Pi:
`enable_file_context.sh` had been part of REBUILD_PI Stage 8 but
**had never run** here — its idempotency check (`grep -q
'"localfilesystem"'`) matched the commented template block in stock
`settings.js`, short-circuiting before any edit. And even if it had
run, its substitution block declared a single store named `default`
backed by localfilesystem — which would have silently routed all
no-scope `flow.set/get` calls across the whole codebase to disk and
still left the `'file'`-scoped calls (which look for a store
literally named `'file'`) unbacked.

**Two-part fix:**

1. **`enable_file_context.sh` rewritten** —
   - Idempotency check now anchors on `^\s+contextStorage:` so the
     commented template doesn't match.
   - Substitution installs **two** named stores plus a string-alias
     default:
     ```javascript
     contextStorage: {
         default: "memory",
         memory: { module: "memory" },
         file:   { module: "localfilesystem" }
     },
     ```
     This keeps every existing no-scope `flow.set/get` in the
     codebase in-memory (zero behaviour change for the 100s of
     such calls outside DXCC) while giving the explicit
     `flow.set/get(..., 'file')` calls a real file-backed store.
   - Ran on the Pi → `~/.node-red/context/` now populated; flow-scope
     file for the DXCC tab landed at
     `~/.node-red/context/d110d176c0aad308/flow.json`.

2. **Readers aligned to `'file'` scope.** 32 mechanical
   substitutions across 5 reader function bodies, regex
   `flow\.get\('(filter\w+|spotTTL)'\)` → `flow.get('$1', 'file')`.
   No structural changes; the regex was tight enough to leave the
   no-scope reads of `dxccReady`, `entityWorked`, `workedTable`,
   `dxccBlacklist`, etc. completely untouched. Per-function count:
   ```
   DXCC Prefix Lookup + Alert Classify    9
   Format Alert for Dashboard Table       7
   Format FlexRadio Spot Command          1
   Format Telegram Alert Dedup 10 minute  8
   Format Telegram Alert                  7
   ```
   Applied programmatically from Mac side after operator
   confirmation (per CLAUDE.md rule #1) since 32 manual editor
   edits across 5 functions had material miss-one-and-it's-silently-half-broken
   risk. Loaded via `git pull` + `sudo systemctl restart nodered`
   on Pi.

**Surfaced bug, queued as HANDOVER #20 — and later closed as
misdiagnosis the same day.** I had flagged a worked-table dual-write
issue in `Fetch All Modes + Parse` based on the `'file'`-only writes
on L91-94. Wrong: a closer read showed the function does *triple*
persistence — L85-88 are memory writes (no scope), L91-94 are file
context writes (`'file'`), and L96-103 also writes `nr_dxcc_seed.json`
to disk directly via `fs.writeFileSync`. Architecture has always been
correct; today's enable-the-file-store fix just makes the L91-94 path
finally land where it always intended. Lesson, recorded for future
audits: filtering scope-by-scope hides parallel writes — scan full
function bodies before claiming a dual-write gap.

**REBUILD_PI.md impact:** none directly — Stage 8 already ran
`enable_file_context.sh`; the script fix flows through automatically.
A fresh rebuild today would now actually produce a working file
context store (previously the install was silently no-oping).

---

### DXCC: Club Log API ban verification — lifted, no flow change (closes CLAUDE.md TODO #10)

Operator confirmed the Club Log API ban from earlier this year is
no longer in effect. Verified live: `nr_dxcc_seed.json` has
`updated: "2026-05-11T03:27:47.276Z"`, written by the daily
`00 02 * * *` cron's `Daily club log refresh (0200)` inject
(`c43fbdd61175ce24`). The fetch chain is healthy end-to-end.

**No flow change.** The current `once: false` posture on
`Load Club Log on startup` (`4ebafea5ce2d9d7b`) and
`Retry Club Log (90s)` (`9c98f9e7a941e852`) remains correct
defence-in-depth, *even with the ban lifted*. Why: those injects
fire on every Deploy (not just every Node-RED restart). Flipping
to `once: true` would mean a 10-deploy active development session
makes 11 Club Log API calls instead of 1. The daily cron + the
existing `POST /dxcc/refresh` HTTP endpoint cover every real
refresh need:

- Scheduled fetch — daily cron, 02:00 IST, 1 call/day.
- Ad-hoc fetch after a session of QSOs — `POST /dxcc/refresh`
  (manual button on the DXCC dashboard).
- Restart-time freshness — `Bootstrap Worked Table`
  (`1a13cd6d9aabaa54`) flips `dxccReady=true` from cached
  `nr_dxcc_seed.json`, so the tracker is fully operational on
  cached data within ~2s of Node-RED start.

**CLAUDE.md cleanup folded in:**

- TODO #10 row reworded to "Closed 2026-05-11 — ban lifted; design
  retained".
- "Data files (must exist in `cfg_flows_dir`)" list was
  inaccurate — claimed `nr_dxcc_maps.json` and `nr_dxcc_modes.json`
  were required. Neither exists on the Pi or in this repo. The
  modes data lives **inside** `nr_dxcc_seed.json` under key
  `dxccModeWorked`; the prefix-to-DXCC-entity map is rebuilt
  in-memory from `cty.xml` on every startup (the file fetched by
  `Load cty.xml on startup` `3720b5e9691dfb9c`). Corrected.
- BACKUP section's "Critical files" list also referenced both
  stale files — replaced with the actual two-file truth.

**REBUILD_PI.md impact:** none. The runbook fetches all DXCC data
from a fresh `git clone` + a runtime cty.xml + a runtime Club Log
call — never depended on the two phantom files existing.

---

### `nrsave`: auto-regenerate DXCC tab extract (closes HANDOVER #17)

Pi-side `nrsave` was an alias on `~/.bashrc:114`:

```
alias nrsave="cd ~/.node-red/projects/vu2cpl-shack && git add flows.json && git commit -m"
```

It did not regenerate `clublog_dxcc_tracker_v7.json` — meaning
CLAUDE.md rule #4 ("on every flows.json commit, extract the DXCC
Tracker tab") was being silently violated on every `nrsave`. The
extract was only refreshed when something on the Mac side did the
python one-liner manually. Today's Parse Strike rebase
([`e8a2dd4`](https://github.com/vu2cpl/shack/commit/e8a2dd4))
had to amend in 97/76-line drift accumulated since whenever the
extract was last regenerated. Don't want that pattern to recur.

Fix: convert the alias to a function (aliases can't run logic
between args, only chain commands), with the extract step
threaded in before `git add`:

```bash
nrsave() {
    cd ~/.node-red/projects/vu2cpl-shack || return 1
    python3 -c 'import json; d=json.load(open("flows.json")); v=[n for n in d if n.get("z")=="d110d176c0aad308" or n.get("id")=="d110d176c0aad308"]; json.dump(v,open("clublog_dxcc_tracker_v7.json","w"),indent=2)' || return 1
    git add flows.json clublog_dxcc_tracker_v7.json
    git commit -m "$1"
}
```

The function fail-fasts if either the `cd` or the extract step
returns non-zero, so a malformed flows.json doesn't get committed
with a stale extract.

**Applied via** a python-based in-place edit of `~/.bashrc` (safer
than `sed` with the JSON literal's quote-soup in the python
one-liner). Backup `~/.bashrc.bak.YYYYMMDD_HHMM` retained on the
Pi. Verified live with `type nrsave`.

**Documentation alignment:**

- **CLAUDE.md rule #4** reworded — now says the regen happens
  automatically inside `nrsave`, with the manual python one-liner
  kept as a fallback for non-nrsave commit paths
- **CLAUDE.md "Save changes" + "GIT WORKFLOW"** sections updated
  to drop the now-redundant manual extract step
- **CLAUDE.md infrastructure table** row reworded from "Git alias"
  to "Git function"
- **REBUILD_PI.md Step 5** — the "Set up the `nrsave` git alias"
  block had been carrying a **stale** definition that wrapped a
  `git save` config alias indirection (a variant that was never
  actually used on this Pi). Replaced with the current function
  form so a fresh rebuild lands the same `nrsave` that's running
  today.
- **`rebuild_pi.sh` Stage 7** — same fix in the automation script.
  Bash syntax-checked.

---

### Lightning: Parse Strike — Blitzortung dead-code strip (closes HANDOVER #7)

[`e8a2dd4`](https://github.com/vu2cpl/vu2cpl-shack/commit/e8a2dd4) —
operator-side flow change, audited + extract-regen-amended +
rebased Mac-side.

After the 2026-05-10 Blitzortung drop (HANDOVER #7), the
`Parse Strike` function node (`26ddff0cbbfe5fc1`, Lightning
Antenna Protector tab) still carried its full Buffer/string parser
for Blitzortung's binary-with-embedded-text TCP feed: ~30 lines of
`findKey` byte-scanner + `readCoord` digit-parser + a CASE 2/3
branch entered on any non-object `msg.payload`. Nothing was ever
wired to feed it — audit of upstream connections returned only:

- 3 TEST inject nodes (object payload)
- `Parse Open-Meteo → Strike` (object payload)

All four upstreams use CASE 1, so CASE 2/3 was unreachable in
production. Replaced the dead branch with a one-line "dropped
2026-05-11 (HANDOVER #7) — restore from git history if reinstated"
note + `return null`. Net flows.json change: 1 insertion, 1 deletion
(function body is a single JSON-encoded string).

**Rule #4 catch-up — DXCC tab extract drift fix:** the operator's
`nrsave` (alias for `git add flows.json && git commit`) did not
regen `clublog_dxcc_tracker_v7.json`, so the extract had been
drifting behind every nrsave-only commit for an unknown number of
days. Today's amend re-ran the extract script and folded the
resulting 97-insertion / 76-deletion diff into the Parse Strike
commit before pushing. Most of the drift was unrelated (`tx_color`
field on FlexRadio slices, AS3935 panel additions, etc. — all
already in flows.json from earlier deploys); just nobody had
re-run the extract. Worth folding the extract step into `nrsave`
itself, but that's a separate Pi-side alias change (HANDOVER #17,
queued).

**No behaviour change** for any payload that actually fires
today — CASE 1 retained verbatim. Only difference: a Buffer or
string payload (which never arrives) now returns null in 1 line
instead of running 30 lines and returning null.

**Mac-side rebase note:** operator's commit landed on a Pi-side
main branch that was 5 commits behind origin (today's doc
commits). Stash-seed → amend-extract → rebase-pull → pop-stash →
seed-commit → push sequence kept history linear and the seed
refresh as its own commit, per repo convention. Operator's
authorship preserved through the amend.

**No `REBUILD_PI.md` impact** — disaster recovery just clones the
repo, and the cleaned-up `flows.json` comes along for free.

CLAUDE.md "Key Node IDs" + HANDOVER.md "Key files & IDs to know"
caveats updated to drop the "Cases 2/3 dead" note (they're not
just dead — they're gone).

---

### LP-700-HID ws tab: Description field cleared (closes HANDOVER #16)

[`72fc31e`](https://github.com/vu2cpl/vu2cpl-shack/commit/72fc31e) —
operator-side. The tab's sidebar Description carried 419 chars of
legacy install instructions (`npm install robertsLando/node-red-contrib-usbhid`
+ telepost udev rules + `gpasswd -a $USER telepost` + unplug/replug
note), all from the pre-WS-gateway era. Useless after the
2026-05-09 migration and 2026-05-11 HID-package uninstall — anyone
following them now would either install a redundant package or
modify udev rules for a `/dev/hidraw*` node we don't even talk to
directly anymore.

HANDOVER #16 had been closed as won't-do earlier today (purely
cosmetic, editor-only sidebar text); operator did it anyway as a
zero-risk paste-the-empty-string change. Reopened and closed as
done.

---

### LP-700: HID package uninstalled (post-WS-migration cleanup)

The 2026-05-09 LP-700 → WebSocket-gateway migration left
`@gdziuba/node-red-usbhid` installed in `~/.node-red/` as a
no-longer-used palette package. CLAUDE.md's "uninstall after a week
of stable WS operation" check has been met (stable since 05-09,
verified end-to-end on the Lightning storm day 05-10 + LP-700 panel
auto-scale work). Cleaned up today:

```sh
cd ~/.node-red && npm uninstall @gdziuba/node-red-usbhid
sudo systemctl restart nodered
```

Node-RED restarted clean (`journalctl -u nodered` showed no
errors), LP-700 panel still rendering at ~25 Hz from the WS path.

The accompanying `-dev` build libs (`libudev-dev`, `librtlsdr-dev`,
`libusb-1.0-0-dev`) — flagged in CLAUDE.md as needing apt removal —
turned out **not to be installed** on the current Pi. Either an
earlier cleanup pass removed them or the original
`node-red-contrib-usbhid` build linked against system libs without
needing the dev headers persistently. Either way, no apt action
needed. The runtime counterparts (`libudev1`, `libusb-1.0-0`,
`librtlsdr0`) remain — they're transitive deps of many system
packages and have nothing to do with the HID node.

**Audit before uninstall:** `grep -nE 'usbhid|hid-manager|@gdziuba'
flows.json` returned only a single stale `info`-description field
on the LP-700-HID ws tab (legacy install instructions in the tab's
sidebar Description). Cosmetic, zero runtime impact — flagged for
the operator to clear via the Node-RED editor when convenient (tab
Properties → Description → empty → Deploy → `nrsave`). Not edited
here because flows.json edits must come from the Pi-side editor as
the source of truth (CLAUDE.md rule #1).

**`npm audit` noise:** the uninstall surfaced "13 vulnerabilities
(12 moderate, 1 high)" from npm's blanket audit across the whole
`~/.node-red` install. Unrelated to this change — same advisories
were present before. `npm audit fix --force` is **not** safe to
run in a Node-RED palette directory (breaks pinned palette
versions). Left as-is.

**REBUILD_PI.md check:** that runbook already did not install
`@gdziuba/node-red-usbhid` or its -dev libs in Step 2 (system
packages) or "Install required palette packages". No
`REBUILD_PI.md` change needed — a fresh rebuild from scratch
will land in the same clean state.

CLAUDE.md `## NODE-RED PALETTE PACKAGES` cleaned up: HID row,
"When ready to clean up" block, and "Original install reference"
archaeology block all removed. Replaced with a brief paragraph
recording the migration + uninstall dates for future
archaeologists.

---

### `gpsntp.local`: log2ram installed (closes HANDOVER #12)

SD card wear mitigation on the stratum-1 GPS NTP server. Chrony +
gpsd run 24/7 and write continuously to `/var/log`; on a Pi 3B with
a consumer SD card this eventually wears out the card. log2ram from
the azlux apt repo mounts `/var/log` as tmpfs (128 MB) and flushes
to SD hourly + on shutdown.

**Procedure followed** ([`pi-gps-ntp-server/BUILD.md`](https://github.com/vu2cpl/pi-gps-ntp-server/blob/main/BUILD.md)
"Optional — Reduce SD card wear"), with one fix: BUILD.md hardcodes
`bookworm main` in the apt sources line, but `gpsntp` is now on
Debian 13 (`trixie`). Confirmed the azlux repo has a `trixie/`
suite before adding it. Steps:

```sh
echo "deb http://packages.azlux.fr/debian/ trixie main" | \
  sudo tee /etc/apt/sources.list.d/azlux.list
sudo wget -q -O /etc/apt/trusted.gpg.d/azlux.gpg https://azlux.fr/repo.gpg
sudo apt update
sudo apt install -y log2ram
sudo systemctl enable log2ram
sudo reboot
```

The `enable --now` form from the BUILD.md doc would not actually
move `/var/log` to RAM on first install — log2ram's bind-mount has
to happen before any service opens a log file, so it only takes
effect on next boot. Reboot is mandatory.

**Verification after boot:**

```
log2ram on /var/log type tmpfs (rw,nosuid,nodev,noexec,noatime,size=131072k,mode=755)
systemctl is-active log2ram      → active
systemctl is-enabled log2ram     → enabled
df -h /var/log                   → 128M total, 612K used
```

Chrony re-locked to stratum 1 with PPS reference within ~60 s of
boot. Numbers at first re-lock: system time 181 ns fast of NTP
truth, root dispersion 16 µs, skew 0.087 ppm, residual freq −0.168
ppm. Indistinguishable from pre-log2ram numbers (as expected —
log2ram only changes where `/var/log` writes land, not anything
chrony reads).

**Fix landed in the other repo** ([`pi-gps-ntp-server@5b115ba`](https://github.com/vu2cpl/pi-gps-ntp-server/commit/5b115ba)):
swapped the hardcoded `bookworm` for `${VERSION_CODENAME}` read
from `/etc/os-release` (release-agnostic — survives the eventual
Debian 14 move), changed `enable --now` to `enable` + explicit
`reboot` with a note explaining why `--now` doesn't actually
move `/var/log` on first install, and added a verify block.

**No REBUILD_PI.md impact** — that runbook is for the shack Pi
(`noderedpi4`); log2ram is on `gpsntp.local`, a different host with
its own (separate) build doc.

---

### N2WQ login pattern — ported to DXClusterAggregator (Swift)

No Node-RED code change. Recording this as a cross-project
reference so future-self knows the canonical fix lives in two
places (and how to keep them aligned).

The 2026-05-10 N2WQ disconnect cycle (see entries above) was fixed
on the Node-RED side via:
- Tightened login regex: short line `endsWith('login:')` style,
  rejects the banner's `Last login:` mention
- Packet-radio SSID suffix `-1` on the callsign sent to N2WQ to
  sidestep the cluster's no-duplicate-login enforcement when
  another LAN client is also logged in as `VU2CPL`

Both patterns have now been ported to the macOS app
**DXClusterAggregator** (Swift, separate repo). Notable Swift-side
porting issues that Node-RED's `tcp in` node had quietly handled
for us:

#### 1. Telnet IAC binary preamble

N2WQ emits 6 bytes of Telnet option negotiation before the prompt:

```
FF FB 03    IAC WILL SUPPRESS-GA
FF FB 01    IAC WILL ECHO
```

These are invalid UTF-8 and corrupt the first chunk if you decode
directly. Node-RED's `tcp in` with `datatype: utf8` silently
strips/replaces them; a raw-socket client (Swift `NWConnection`,
Python `socket.recv`, raw `nc`, `socat`) sees them verbatim.

Swift fix: byte-level `stripTelnetIAC(_:) -> Data` scanner that
drops `IAC WILL/WONT/DO/DONT` (3-byte sequences), `IAC SB ... IAC SE`
(variable subnegotiation), `IAC IAC` (literal 0xFF), and other
2-byte IAC commands. Applied to every `receive()` chunk before
String decoding. No reply needed — clusters tolerate silent
partners fine.

#### 2. Hanging prompt without trailing LF

N2WQ sends `login: ` with no LF — a classic Telnet hanging prompt
waiting for a live cursor. Code that splits incoming bytes only on
newlines never sees the prompt; bytes accumulate in the buffer
forever, the server times out, infinite reconnect loop.

Swift fix: after the line-buffer loop drains LF-terminated input,
peek at the residual `buffer`. If it trims to a short string
(`< 40` chars) ending in a recognized login/password prompt suffix,
hand it to the auth handler and consume.

Node-RED's `tcp in` model accidentally handles this fine — each
TCP chunk arrives as its own `msg.payload`, treated as a complete
unit by our function. No line buffer to drain. Different model;
same outcome.

#### Cross-project alignment

Both implementations use the same prompt suffix list:
`login:`, `please login`, `please login:`, `callsign:`,
`callsign please:`, `your callsign:`, `enter your callsign:`.
Treat this list as a shared canon — if a new cluster needs a
different prompt match, update both. The Swift code centralises
its list as `static let promptSuffixes`; the Node-RED code keeps
it inline in `Login + Parse + Dedup` (`login-parse-dedup-v2`).

Both also rely on operator configuration to set a callsign-SSID
(e.g. `VU2CPL-1`) when an LAN-side duplicate is detected. No code
change to enable — just edit the cred / source-config field on
each side.

#### Lessons portable to any cluster client

1. **A login prompt is a short line ending with the indicator.**
   Detecting `login:` as a substring anywhere will eventually
   match a banner mention. Use `endsWith()` plus a sanity length
   guard.
2. **Telnet IAC negotiation must be stripped at byte level** for
   raw socket clients. Anything decoding UTF-8 from `recv()` will
   either choke or get garbage on the first chunk.
3. **Cluster software enforces uniqueness on the bare callsign**;
   packet-radio SSIDs (`-1` through `-15`) are accepted as
   distinct logins by most AR-Cluster forks. `-N` letter suffixes
   are not always validated cleanly; numeric SSIDs are the safest
   default.
4. **Hanging prompts vs newline-terminated input** are two
   different I/O paths. If your client splits on `\n` only, you
   need an explicit "buffer residual after split, check for prompt"
   path or you'll deadlock on the very first connection.

No Node-RED code change in this commit. Documentation only.

---

## 2026-05-14

### Lightning dashboard — label Event Log times as IST

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)
**Node:** Master Dashboard ui_template (`557083037f168b22`)

Event Log header changed from `Event Log` to
`Event Log · times in IST (UTC+5:30)`. No code path or logging
behaviour changed — purely a UI label so the timestamps in each
log row (which come from the AS3935 bridge's local-formatted
`timestamp` field, falling back to `new Date().toLocaleString()` on
the Pi) are unambiguously read as Asia/Kolkata local time and not
UTC.

The on-disk JSONL historic store (`nr_lightning_events.jsonl`,
added 2026-05-13) is unaffected — it stays UTC ISO-8601 via
`new Date().toISOString()` for archival use. Dashboard = IST,
archive = UTC.

Follow-up tracked as TODO #13 in CLAUDE.md: the AS3935 Local Sensor
card duplicates the same local timestamp in both the "Last seen"
field and the Disturber / Noise status chip — declutter pending.

### Tasmota — set Timezone to IST (+05:30) on all 5 devices

**Devices:** `powerstrip1`, `powerstrip2`, `powerstrip3`,
`4relayboard`, `16Amasterswitch`.

The 16A master switch's `ENERGY.Today` counter on the dashboard was
resetting at 05:30 IST instead of local midnight, because the
Tasmota device was running on the firmware default `Timezone 0`
(UTC). `Today` is computed and rolled over inside Tasmota itself
based on its local-clock date — Node-RED just forwards the value
(`Parse 16Amasterswitch` → `Energy Aggregator` → `16A Energy
Monitor`). No flow change needed; fix is per-device:

```bash
for t in powerstrip1 powerstrip2 powerstrip3 4relayboard 16Amasterswitch; do
  mosquitto_pub -h 192.168.1.169 -t "cmnd/$t/Timezone" -m "5:30"
done
```

Verified all 5 with empty-payload read-back — each replied
`{"Timezone":"+05:30"}` on its `stat/<device>/RESULT` topic. Setting
persists in Tasmota NVS across reboots.

**One-time anomaly for today (2026-05-14):** the timezone change
landed at ~15:00 IST. The current `Today` counter (1.120 kWh at the
moment of verification) reflects accumulation since the *last*
rollover, which happened at 00:00 UTC = 05:30 IST today — so it's
only 9.5 h of data, not a full 24 h. The first clean IST midnight-
to-midnight cycle begins at 00:00 IST on 2026-05-15.

Documented in CLAUDE.md Hardware Map (Tasmota Power Devices section)
and in REBUILD_PI.md Step 11 so a fresh Tasmota reflash doesn't
silently revert to UTC. The other 4 devices don't have energy
monitoring, but their internal `Timer` actions and log timestamps
would have been 5.5 h off — now consistent across the shack.

### Lightning dashboard — Event Log survives Node-RED restart

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)
**New nodes:** `light_bootstrap_inj_01` (inject) +
`light_bootstrap_fn_01` (function). Node count 76 → 78.

**Problem.** After every `sudo systemctl restart nodered`, both the
Event Log widget and the AS3935 card's "Last seen" field showed
blank. Root cause is two-fold:

1. `flow.event_log` lives in **memory** context (no `'file'` scope on
   any `flow.get`/`flow.set` call), so restart wipes it. The
   `Stats refresh every 30s` inject then sends `{type:'log', html:''}`
   every 30 s, painting `logLines.innerHTML = ''` → blank.
2. The on-disk JSONL store (`nr_lightning_events.jsonl`, added
   2026-05-13 in commit `bf480be`) had all the history, but no
   startup node read it back into `flow.event_log`.

**Fix.** New inject `Bootstrap Event Log (startup)` fires once at
`onceDelay: 2 s` (after Init Defaults at 0.5 s, before Stats refresh
at 3 s) into a new function `Bootstrap Event Log from JSONL`. The
function:

- Reads `flow.cfg_events_jsonl` (set by Init Defaults).
- Loads the file, splits by newline, takes the last 50 records
  (mirrors the in-memory cap in `AS3935 Warn Log` /
  `AS3935 Disconnect Log`).
- Reverses to match the live unshift-built order (newest first).
- Extracts the pre-rendered `rec.html` field from each line
  (already present — every existing JSONL writer includes the
  full HTML row alongside the structured fields).
- Sets `flow.event_log` to the result and emits one
  `{type:'log', html:…}` to Master Dashboard for immediate paint.
- ENOENT (no JSONL yet) → silent grey status; malformed JSON lines
  skipped silently; other I/O errors → red status + `node.error`.

`libs: [{var:'fs', module:'fs'}]` declared on the function (same
pattern as `Append Lightning JSONL`) — function nodes need explicit
module imports per the lesson from commit `c8fbcb4`.

**What this does not fix.** "Last seen" (`a35time`) still blanks on
restart until the next AS3935 disturber/noise/strike event. The
JSONL records lack the right shape to synthesise a clean
`as3935_status` replay (records are `type: warn|disconnect|reconnect`,
not `event: disturber|noise`), so bootstrapping it properly needs
the AS3935 ESP32 bridge to publish a retained "last event"
message — separate larger fix, folded into TODO #13 (AS3935 card
declutter) when we tackle it.

**Behaviour summary.** First Deploy after this commit: bootstrap
fires at +2 s, dashboard shows the last 50 events from JSONL within
3 s of startup. Subsequent restarts: same, transparently. No
behaviour change to the running flow — pure additive bootstrap.

### Lightning dashboard — AS3935 card declutter (TODO #13 closed)

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)
**Node:** Master Dashboard ui_template (`557083037f168b22`)

Two cosmetic problems on the AS3935 Local Sensor card:

1. **`LAST SEEN` showed an absolute timestamp** like `14:32:05` —
   information that decays in usefulness as time passes ("was that
   today? yesterday?").
2. **The right-side status chip repeated the same timestamp** during
   the 60 s disturber/noise window: `⚠ Disturber  14:32:05` — visually
   noisy and redundant once `LAST SEEN` had the same value.

**Fix** (pure ui_template edit; no flow change):

- `LAST SEEN` now shows **relative age** — `"4s ago"` / `"3m ago"` /
  `"1h 14m ago"` / `"2d ago"` — same format used by the existing
  `alertBox` recap line. Hovering the value reveals the absolute IST
  timestamp via `title` tooltip, so the precise value isn't lost.
- A 30 s ticker auto-refreshes the relative-age string while a
  last-event timestamp is held in JS state. Ticker is started lazily
  on the first event (no work until something happens).
- Three call sites in the disturber / noise / strike branches all
  funnel through a new `recordAS3935Event()` helper that captures
  `Date.now()` and repaints. Receive-time is used, not the bridge's
  timestamp string — avoids parsing the bridge format and the
  relative-age display is insensitive to the small
  bridge→broker→browser skew.
- Chip text on disturber/noise dropped the trailing timestamp:
  `'⚠ Disturber  ' + d.timestamp` → `'⚠ Disturber'`. Strike chip
  (`⚡ X km (Y)`) was already clean.

**What this does NOT fix.** After a Node-RED + browser restart,
`LAST SEEN` is still blank until the next AS3935 disturber/noise/
strike. Bootstrapping it from JSONL doesn't work cleanly because
JSONL records are `type: warn|disconnect|reconnect` (per the log
writers) — they don't carry the right shape to drive `a35time`.
The proper fix is to have the AS3935 ESP32 bridge publish a
**retained** `lightning/as3935/last_event` topic so the broker
replays the most recent event on Node-RED reconnect. Tracked as
TODO #15 in CLAUDE.md.

**Minor immaterial leftover.** The disturber / noise / strike
branches each still declare `var timeEl = document.getElementById('a35time');`
even though the `recordAS3935Event()` helper now gets the element
itself. Unused variable; harmless; left as-is to keep this diff
focused on the visible change.

### Lightning dashboard — Atmospheric CAPE tile + AS3935 chip one-liner

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)
**Nodes:** Master Dashboard ui_template (`557083037f168b22`),
Parse Open-Meteo → Strike (`593f22a507b46335`).

**Atmospheric CAPE tile.** The OM parser already computed `cape` and
derived `om_state` (`cold` / `lit` / `severe`) for the
distance-graded disconnect matrix, but nothing on the dashboard
showed the actual number. New tile under the Reconnect Timer in
`#threshBox`:

- Title: `Atmospheric CAPE`
- Value: `<rounded J/kg>` (e.g. `1842 J/kg`), font-size 28 px
  (matches Disconnect Threshold styling)
- Colour mapping driven by `om_state`, not raw CAPE — because
  `om_state` already accounts for the WMO-thunderstorm gate
  (CAPE ≥ 800 alone isn't "lit" without a thunderstorm WMO code):
  - `cold`   → green (`--green`)
  - `lit`    → amber (`--amber`)
  - `severe` → red   (`--red`)

Plumbing: Parse Open-Meteo's output 2 (the "always emit" dashboard
log path) now sends two messages instead of one — `[logMsg, capeMsg]`
where `capeMsg.payload = {type:'cape', cape, om_state}`. Node-RED
dispatches both sequentially to the Master Dashboard. New
`paintCape(cape, state)` helper + `{type:'cape'}` handler in
`scope.$watch`. Updates every 5 min (OM poll cadence). On boot,
tile shows `— J/kg` muted until first OM response (~5 s after Init
Defaults).

**AS3935 chip one-line + title rename.** The status chip
(`✓ READY · NF=4 · UP 6H 50M · IRQ=24`) wrapped to two lines because
the chip span allowed text wrapping and the header title
(`AS3935 LOCAL LIGHTNING SENSOR`) ate too much of the residual flex
width. Two small fixes:

- `white-space: nowrap` on `#as3935Evt` inline style — chip text now
  stays on one line.
- Header title text changed: `AS3935 Local Lightning Sensor` →
  `AS3935 Sensor`. The parent CSS `text-transform: uppercase`
  renders it `AS3935 SENSOR`, freeing ~16 chars of horizontal
  space for the chip. No CSS changes — the title change alone
  combined with the chip nowrap is enough at the current card
  width.

CLAUDE.md "Master Dashboard message types" list updated with the
new `{type:'cape', cape, om_state}` payload shape.

### Lightning dashboard — AS3935 status self-heal (chip rehydrates without manual republish)

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)
**Modified:** `Replay AS3935 State` (`as3935_replay_state`) — outputs 1 → 2, function body augmented.
**Added:** `AS3935 Cmd → bridge` (`as3935_cmd_mqtt_out`) — `mqtt out` to `lightning/as3935/cmd`. Node count 78 → 79.

**Symptom.** After `sudo systemctl restart nodered`, the AS3935
status chip (`✓ READY · NF=4 · TUN=9`) stayed blank until the
operator manually triggered `republish_status` from the AS3935
Control Panel. Heartbeats kept arriving every 30 s (chip handler is
hb-aware) but the `as3935_hb` handler is a no-op unless
`window._as3935Ready` is set, which only happens after the dashboard
receives an `{type:'as3935_ready', ...}` message.

**Diagnosis.** Three facts narrowed it down:

1. `mosquitto_sub -h 192.168.1.169 -t 'lightning/as3935/status' -C 1 -W 3`
   from the Pi returned the retained payload instantly — broker
   has it correctly retained.
2. The MQTT broker config (`f4785be9863eab08`) is plain
   `cleansession: true`, no clientid, no birth/will — nothing
   that would suppress retained delivery.
3. A debug node wired to `as3935_mqtt_status` proved that when
   the bridge does publish (republish_status, or boot), Node-RED
   receives and processes the message cleanly end-to-end.

The retained-on-subscribe delivery to Node-RED's MQTT client is
unreliable across restarts (likely a broker-connect ↔ subscribe ↔
retained-flush timing race that `mosquitto_sub` doesn't hit because
it's a single fresh client). Rather than chase the exact race, the
self-heal sidesteps it: ask the bridge to republish whenever the
cache is empty.

**Implementation.**

- `Replay AS3935 State` now has 2 outputs:
  - **Output 1** → Master Dashboard (`557083037f168b22`) —
    unchanged: re-emits cached status + hb every 30 s (the existing
    page-refresh-survival behaviour).
  - **Output 2** → new `AS3935 Cmd → bridge` mqtt-out (`lightning/as3935/cmd`).
    When `flow.as3935_status` is null, sends `{action:'republish_status'}`
    to the bridge. Bridge replies on `/status`, Format AS3935 State
    caches it, next tick (within 30 s) populates the dashboard.
- **Cooldown:** 5 min, tracked in node-local `context.lastRepublishReq`.
  Prevents flooding the bridge if the cmd path itself is broken
  (e.g. bridge offline). Resets on Deploy — fine, by design.
- **Node status:** yellow ring "status null → republish req" when
  firing; grey ring "status null · cooldown Ns" when waiting; cleared
  once the cache populates.

**Effect.** Within 30 s of any Node-RED restart (or any other event
that empties the cache), the dashboard chip rehydrates without
manual intervention. Same self-heal trips for broker restart,
ESP32 reconnect, or any other timing hiccup that causes the
retained delivery to be missed.

**Bridge firmware (TODO #15-adjacent, not done here).** The "right"
fix in addition would be a retained `lightning/as3935/last_event`
topic from the ESP32 — that solves both the chip rehydration AND the
"Last seen" rehydration in TODO #15. The self-heal added in this
commit is the dashboard-side complement; it works regardless of the
firmware change.

**Cleanup for operator.** If you added a temporary debug node wired
to `as3935_mqtt_status` for diagnostics during this session, delete
it (it's not part of the committed flow).

### AS3935 Tuning — Control Panel rehydrates within 5 s of opening the page

**Tab:** AS3935 Tuning (`fe70cfdcdfa19aa4`)
**Added:** 5 nodes. **Rewired:** 3 mqtt-in destinations.

**Problem.** Opening the AS3935 Tuning dashboard page in a fresh
browser tab showed empty `/status` data (`FW —`, `IP ?`, `Calib:
TRCO=? · SRCO=?`) until the operator manually clicked `Republish
Status`. The Control Panel's three mqtt-in nodes (`/status`, `/hb`,
`/cmd_ack`) wired directly to the ui_template; `resendOnRefresh`
only stores the *last* message, which is always an `/hb` (publishes
every 30 s), so refreshes never replayed `/status` (publishes only
on bridge boot / settings change / `republish_status`).

**Why this is the 2nd attempt — and why a 5 s tick, not
`ui_control`.** First attempt (commit `6664286`, reverted in
`5e0f467`) used `node-red-dashboard`'s `ui_control` node, which emits
a message on client connect / tab change. Would have given <100 ms
rehydration. Failed because `ui_control` is **not shipped in this
`node-red-dashboard 3.6.6` install** — confirmed by
`npm install node-red-dashboard@3.6.6 --force`, the
`nodes/ui_control.html` and `nodes/ui_control.js` files are genuinely
absent from the package. Whether that's a 3.6.6 packaging regression
or specific to this install isn't worth chasing; the fast-tick
substitute works and stays simple.

**Fix — cache + 5 s replay tick.**

- Three pass-through cache functions inserted between the mqtt-ins
  and the Control Panel:
  - `as3935_tuning_cache_status` → `flow.as3935_status`
  - `as3935_tuning_cache_hb` → `flow.as3935_hb`
  - `as3935_tuning_cache_ack` → `flow.as3935_cmd_ack`
  Each is two lines: `flow.set(key, msg.payload); return msg;`. Live
  MQTT traffic still reaches the Control Panel unchanged.

- `as3935_tuning_replay_tick` inject, `repeat: 5`, `onceDelay: 1`.

- `as3935_tuning_replay_fn` reads the three caches and re-emits
  whatever's populated to the Control Panel with original topics
  preserved (`lightning/as3935/status`, `/hb`, `/cmd/ack`). The
  Control Panel's existing `scope.$watch('msg', ...)` consumes them
  with no template change. Node status reports
  `replay tick · N msg(s)` for visibility.

**Effect.** Opening the AS3935 Tuning dashboard tab cold (browser
restart, fresh tab, new client) — Control Panel fully populates
within ≤5 s. No `Republish Status` click. No browser hard-refresh.

**Background load.** 5 s tick = ~17 k internal Node-RED messages/day
per cache populated, each a tiny JSON object. Trivial; no measurable
CPU on the Pi.

**Audit follow-up (TODO #16 in CLAUDE.md, renumbered from the
reverted attempt).** Same pattern applies to any other widget that
has the same "infrequent publishes + multiple message types" shape.
Most likely candidates are tabs with status readouts and config
displays (e.g. RPi Fleet Monitor, FlexRadio panel — if those have
similar gaps, treat them the same way). High-frequency widgets
(LP-700 SWR, FlexRadio meters polled live) probably need nothing —
their data flows constantly.

**Side note.** `node-red-contrib-mdashboard 2.19.4-beta` is also
loaded on the Pi (operator is evaluating it). Mdashboard's nodes use
`mui_*` prefix — different namespace from Dashboard 1's `ui_*` — and
the existing flow uses zero `mui_*` types, so the two coexist
without conflict. Mdashboard does **not** cause the `ui_control` gap;
that's a Dashboard 1 packaging issue independent of mdashboard's
presence.

### Lightning tab — Stats refresh tick: 30 s → 10 s

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)
**Node:** Stats refresh inject (`77ec1b216f0c061b`).

Renamed `Stats refresh every 30s` → `Stats refresh every 10s` and
`repeat: 30` → `repeat: 10`. One inject config change.

This inject fans out to 5 dashboard-replay functions:
`Replay Bypass State`, `Stats → Dashboard`, `Sync Switch State`,
`Log → Dashboard`, and `Replay AS3935 State`. All five now refresh
3× faster, so the Lightning chip, bypass state, stats counts,
antenna/radio switch indicators, and Event Log all rehydrate within
≤10 s of opening or refreshing the dashboard (instead of ≤30 s).

Background load: each replay reads flow context and emits 1–2 small
JSON messages to a ui_template. Three of those (bypass, switch, log)
are no-ops most of the time (only emit if there's something to
replay). `Replay AS3935 State` self-heal (5-min cooldown) is
unaffected — fires no more frequently than before.

Same instant-on philosophy as the AS3935 Tuning fix earlier today,
just applied to widgets that already had a replay tick and just
needed it sped up. Worth a separate audit pass for tabs without any
replay infrastructure yet — TODO #16.

### AS3935 card: chip colour + raw distance/energy on disturber & noise

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)
**Node:** Master Dashboard ui_template (`557083037f168b22`).

Two small follow-ups to the AS3935 card behaviour:

1. **Chip text colour now matches event type.** Previously the
   `as3935_status` disturber/noise branches set `evtEl.textContent`
   but didn't touch `evtEl.style.color`, so the chip text inherited
   whatever colour the last `✓ READY` paint left it (green) — even
   when displaying `⚠ Disturber` / `📡 Noise`. Now:
   - `⚠ Disturber` → `var(--amber)` (matches the LED colour for the same event)
   - `📡 Noise` → `var(--muted)` (matches its LED colour)
   The `✓ READY` / `⚠ CALIB?` paint logic was already correct and is unchanged.

2. **Raw distance/energy shown on disturber/noise too.** Previously
   forced to `—` because the AS3935 chip's distance value for
   non-lightning events isn't physically meaningful. But the raw
   value (which can be `63` = "out of range", or any other value
   the chip's detection algorithm outputs) is useful for tuning
   (`AS3935 Control Panel` calibration work) and for understanding
   why a particular event was classified the way it was. Now both
   branches show `d.distance` / `d.energy` if present, falling back
   to `—` only when the bridge omits the field.

Strike branch (real lightning) was already correct on both counts
— left unchanged.

### AS3935 LAST SEEN: dashboard side of TODO #15 (firmware to follow)

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)
**Added:** 1 mqtt-in node. **Augmented:** Format AS3935 State, Replay
AS3935 State, Master Dashboard ui_template.

Wires up the Node-RED side of the "LAST SEEN survives restart" plan
from TODO #15. The bridge firmware change in
[`vu2cpl-as3935-bridge`](https://github.com/vu2cpl/vu2cpl-as3935-bridge)
will publish a retained `lightning/as3935/last_event` topic with
`{event, distance, energy, ts_epoch_ms}` on every disturber / noise /
lightning event. This commit prepares the dashboard side; until
firmware ships, the new mqtt-in is silent.

**Changes:**

- **New** `as3935_last_event_mqtt_in` — mqtt in on
  `lightning/as3935/last_event`, QoS 1, JSON, same broker as the rest.
  Wires into the existing `as3935_format_state` function.
- **`as3935_format_state`** augmented with a third `else if` branch:
  matches topics ending in `/last_event`, caches to
  `flow.as3935_last_event`, emits
  `{type:'as3935_last_event', event, distance, energy, ts_epoch_ms}`
  to Master Dashboard. Node status reports `last_event: <event>`.
- **`as3935_replay_state`** augmented to also replay the cached
  `last_event` on every 10 s Stats refresh tick. Lives alongside the
  existing status + hb replay and self-heal cmd logic from
  commits `83f4b20` and earlier.
- **Master Dashboard ui_template** — new handler for
  `d.type === 'as3935_last_event'`. Seeds `as3935LastTs = d.ts_epoch_ms`
  and calls `paintAS3935Age()` + starts the 30 s ticker. Inserted
  before the existing `as3935_status` handler. Handler is no-op when
  `d.ts_epoch_ms` is missing.

**Effect (once firmware ships):**

- Node-RED restart → broker replays retained last_event immediately
  to the new mqtt-in → `as3935_format_state` caches + emits →
  Master Dashboard seeds `as3935LastTs` and paints `LAST SEEN` with
  correct relative age within ~100 ms of subscribe.
- Browser refresh / new tab → either the retained payload is
  replayed (resendOnRefresh on dashboard widget) OR the 10 s replay
  tick re-emits within ≤10 s.
- Combined: `LAST SEEN` is correct everywhere, always, no need to
  wait for a live disturber/noise/strike.

**Until firmware ships.** The new mqtt-in is a quiet subscriber on a
topic nobody publishes to. `as3935_format_state` never enters the
new branch. Behaviour unchanged from this commit's predecessor.

**Master Dashboard message types** updated in CLAUDE.md with the new
`{type:'as3935_last_event', event, distance, energy, ts_epoch_ms}`
shape.

## 2026-05-15

### Lightning — Telegram alerts (Standard scope: disconnect, reconnect, bypass, sensor health)

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)
**Added:** 5 nodes. **Modified:** Init Defaults, Append Lightning JSONL,
Bypass Handler wires, AS3935 Status mqtt-in wires. Node count 80 → 85.

Sends Telegram messages on the 6 most operator-relevant lightning
events:

| Type | Trigger | Message |
|------|---------|---------|
| `disconnect` | `Trigger Disconnect` fires, antenna goes OFF | ⚡ ANTENNA DISCONNECT + source + km + time |
| `reconnect` | `Execute Reconnect` fires, antenna back ON | ✅ ANTENNA RECONNECT + reason + time |
| `bypass_on` | Operator clicks BYPASS on dashboard, mode enters ON | 🔕 BYPASS ON + auto-off timer + time |
| `bypass_off` | Operator clicks BYPASS again or 2-h timer expires | 🔔 BYPASS OFF + time |
| `sensor_offline` | AS3935 ESP32 bridge LWT fires (`event:"offline"` retained on `/status`) | ⚠ AS3935 OFFLINE + time |
| `sensor_online` | Bridge re-publishes `/status` with `event:"ready"` after offline | ✓ AS3935 ONLINE + time |

**Excluded** (would spam): disturber + noise events, Open-Meteo polls,
heartbeats, TEST injects (filtered on `source` containing `'TEST'`).

**Credentials.** Reads `TELEGRAM_TOKEN` + `TELEGRAM_CHAT_ID` from the
existing systemd env (`/etc/systemd/system/nodered.service.d/secrets.conf` —
same source DXCC Credentials uses). Init Defaults reads and sets
`flow.cfg_tg_token` + `flow.cfg_tg_chat_id`. No new secret storage,
no duplication.

**Architecture.**

- `Append Lightning JSONL` now has 1 output instead of 0: still
  appends to `nr_lightning_events.jsonl` first, then forwards the
  msg downstream to `tg_lightning_router`. JSONL store and Telegram
  see the same `event_record`s.
- `tg_lightning_router` filters by allow-list, rate-limits per type
  (5 events in 60 s → one suppression notice → silence until activity
  slows), formats HTML message with shack callsign + event-specific
  fields, sets `msg.url` / `msg.method` / `msg.headers` / `msg.payload`
  for the http-request node. Status surfaces what was last sent.
- `tg_lightning_http` is a stock `http request` node — URL blank
  (per the Telegram HTTP request convention in CLAUDE.md), POST,
  JSON body, 8 s timeout. Wires to `tg_lightning_debug` for response
  visibility in the editor sidebar.

**Transition detectors** added to surface events that don't currently
emit `event_record`:

- `bypass_xition_detector` — tapped off Bypass Handler output 1
  (which fans out `bypass_state` + `log` messages to Master Dashboard).
  Filters on `bypass_state`, detects ON↔OFF via `context.lastBypassOn`,
  emits `event_record { type: 'bypass_on' | 'bypass_off', expires_min,
  source: 'operator', html }`. First sample after flow start
  suppressed (can't distinguish "transition" from "initial state").
- `as3935_health_xition` — tapped off AS3935 Status (retained)
  mqtt-in (parallel wire alongside `as3935_format_state`). Watches
  the `event` field (`ready` vs `offline`), detects transitions via
  `context.lastOffline`, emits `event_record { type: 'sensor_offline'
  | 'sensor_online', source: 'AS3935', html }`. First sample
  suppressed. Note: the retained payload always replays on subscribe,
  so the suppression is essential — otherwise every Node-RED restart
  would falsely "transition" to whatever the current state is.

Both transition detectors wire to `light_jsonl_append_01`, which
both persists to JSONL and forwards to the Telegram Router. So
bypass + sensor-health events now also live in the historic store —
useful for retrospective analysis.

**Rate-limit semantics.** Per `rec.type`, a sliding 60 s window
allows up to 5 events. The 6th arrival within the window emits one
suppression notice (`"5 disconnect events in 60s — further duplicates
suppressed until activity slows"`) and then stays quiet. Once the
window drains below 5, the counter resets and normal sending
resumes. Prevents storm-day noise; the operator still gets the
first 5 disconnects of a cluster and a clear marker that more are
happening.

**Sister-channel cross-ref.** DXCC Tracker has its own Telegram path
for NEW DXCC alerts; same bot, same chat, same shack signature
prefix. Both channels coexist — no plumbing collision because they
use separate routers + separate http-request nodes.

### SPE (WS) — ON_SPE routes through WebSocket, exec node removed

**Tab:** SPE (WS) (`spe_ws_tab_01`)
**Modified:** `Button → WS command` (`ws_btn_router`).
**Removed:** `SPE power-on script` exec node (`ws_spe_power_on_exec`).

The dashboard's `ON_SPE` button was the only one taking a different
code path: a Node-RED `exec` node ran `python3 /home/vu2cpl/power_spe_on.py`
on the Pi, which toggled the FTDI's DTR/RTS to cold-start the amp.
Every other button (MODE, TUNE, INPUT, …, OFF_SPE) sent a command
string over the WebSocket to the `spe-remote` server.

Reviewing the `spe-remote` source revealed that the WebSocket server
**already handles `power_on` internally** via the same DTR/RTS toggle
— `spe/power_control.py` `_power_on_sync()` does exactly the
sequence `DTR=1 → DTR=0 → RTS=1 → wait 1 s → DTR=1 → RTS=0`, the
same one in `power_spe_on.py`. The amp's CPU being off doesn't
matter because the FTDI hardware lines are controlled at the host
end via ioctl, independent of whatever's on the other end of the
serial cable.

The old `ws_btn_router` comment justifying the exec detour was
wrong: it conflated the *serial data link* (which is dead when the
amp is off — no CPU on the other end) with the *FTDI hardware
lines* (which remain controllable regardless). Cleaned up.

**Changes:**

- `ws_btn_router` simplified: `outputs: 2 → 1`, special-case `if
  (msg.payload === 'ON_SPE') return [null, msg]` removed,
  `ON_SPE: 'power_on'` added as a regular entry in the command map.
  Function now mirrors every other button.
- `ws_spe_power_on_exec` exec node deleted entirely.
- `ws_pwr_result_dbg` debug node **kept** — `ws_parse_node` still
  routes `power_result` responses (the structured ack from
  `spe-remote` on `power_on` / `power_off`) to it, which is actually
  *more* useful than the script's stdout was. Provides visible
  confirmation in the editor sidebar that the DTR sequence ran.

**`power_spe_on.py` stays on the Pi as a standalone fallback** if
the `spe-remote.service` is down (Pi-side cron / manual script could
still hit the FTDI directly). Just not in the dashboard's runtime
path anymore.

Sister-repo handover: see `spe-remote/handover.md` for the
canonical documentation of this consolidation from the server
side — clarifies that clients should use `power_on` over WS, not
spawn the standalone script.

### Dashboard rehydration audit (TODO #16 closed)

**Tabs touched:** Solar (`590e889d44815afb`),
RBN Skimmer (`f9a0e3ad0e019052`), RPi Fleet (`d5fec2fea3dd37f4`).
**Modified:** 3 function nodes (the state aggregators on each tab).

The audit walked all 10 remaining dashboard tabs after yesterday's
AS3935 Tuning + Lightning chip fixes. Encouraging finding: 11 of 12
widgets already have `storeOutMessages: true` + `resendOnRefresh: true`
AND are fed by a single "State Aggregator" function pattern that
emits the **full state object** on every update (not partial diffs).
On browser refresh, Node-RED dashboard replays the last full-state
message → widget paints completely. The pattern just works without
any of the cache + replay-tick scaffolding we built for AS3935 Tuning.

(The AS3935 Tuning Control Panel was the exception precisely because
its widget dispatched on `msg.topic` with three separate input topics —
`resendOnRefresh` could only store one. Aggregator widgets bypass that
limitation.)

**Real gaps found — 3 aggregators on slow-poll sources** that lose
state on Node-RED restart because their `flow.set` was on memory
context:

- `Solar State Aggregator` — 5–15 min HTTP polls (NOAA, Open-Meteo,
  prop.kc2g.com)
- `RBN State Aggregator` — RBN spots, event-driven and bursty
- `RPi State Aggregator` — 60 s MQTT telemetry from each Pi

If you restart Node-RED between polls, the dashboard sits
half-populated until the next poll cycle. For Solar that's up to 15
min of stale display.

**Fix:** swap both the `flow.get` and the `flow.set` to use `'file'`
scope. State persists to disk (via the `localfilesystem` context
store enabled by `enable_file_context.sh` per TODO #6), survives
Node-RED restart, and the dashboard paints from the last-saved state
within seconds.

```js
// Before:
var st = flow.get('solarState') || {};
...
flow.set('solarState', st);

// After:
var st = flow.get('solarState', 'file') || {};
...
flow.set('solarState', st, 'file');
```

Each aggregator's state object is plain JSON (no circular refs, no
non-serializable types), so the file-store serialisation Just Works.
Write frequency is low — Solar writes ≤ once per 5 min, RBN on each
spot batch, RPi every 60 s. No perf concern.

**Verified no key conflicts.** Each of `solarState`, `rbn_dash`,
`rpi_dash` is touched ONLY by its respective aggregator (no other
node reads or writes them), so the scope swap is self-contained and
can't desync with another reader.

**Power Strips checked but not modified.** The
`Poll Tasmota state every 10s` inject re-queries every device every
10 s, so `flow.power_states` and `flow.energy_state` stay fresh
continuously regardless of restart. Worst-case rehydration ≤10 s,
meets the bar without changes.

**Tabs already fine (no changes):** Rotor, FlexRadio, LP-700 (WS),
SPE (WS), DXCC Tracker (bootstraps from disk), GPS NTP (retained
MQTT), Internet/network (30 s pings), Power Strips (10 s poll).

### FlexRadio — split-mode slice coloring (TODO #2 closed)

**Tab:** FlexRadio (`a0a882f85c89cffc`)
**Nodes:** `Flex State Aggregator` (`de6b988cbc7182ca`),
`FlexRadio Panel` (`bf129ed26ea2ca5f`).

**Problem.** In FlexRadio split mode, both the RX and TX slices
report `tx==1` (because both are "transmit-capable"). The
discriminator is the `active` field: the RX slice (currently
focused for listening) has `active==1` and the TX slice (where the
mic + key go) has `active==0`. The dashboard's previous condition
`tx==1 && active==1` therefore picked the RX as the "TX slice" —
painted colours backwards on every split-mode operation.

**Fix.** Pre-compute a per-slice `isTx` boolean in the aggregator,
where we have visibility across all slices, then have the dashboard
consume just that boolean.

`Flex State Aggregator`: new block before the existing
`activeSlices` loop counts `tx==1 && in_use==1` slices, then sets
`sl.isTx` on each:

- `tx != 1`           → `isTx = 0`
- multiple `tx==1`    → `isTx = 1` only if `active == 0` (split mode)
- single `tx==1`      → `isTx = 1` (normal mode)

`isTx` is propagated into each `activeSlices` push so the
dashboard's `ng-repeat` sees it.

`FlexRadio Panel`: two `ng-class` expressions updated:

- `activeSlices` loop:
  `s.tx==1 && s.active==1` → `s.isTx==1`
- `slices[s]` grid (the `['A','B','C','D']` loop, appearing twice
  in the same ng-class ladder for "transmitting" + "active"
  states): `msg.payload.slices[s].tx==1 && msg.payload.slices[s].active==1`
  → `msg.payload.slices[s].isTx==1`

**Single source of truth.** The aggregator owns the "which slice is
actually transmitting" decision. If FlexRadio changes split-mode
semantics in the future, only the aggregator needs touching — the
dashboard just reads the boolean.

**Verified by inspection of the aggregator + panel logic.** Live
verification: next time you split-tune (e.g. listen on the DX
station's frequency, transmit on the split — common during pile-ups),
the RX-side slice should be the green one and the TX-side slice
should be the yellow/amber one. Previously the colours would have
been swapped.

---

## 2026-05-17

### AS3935 dashboard — import v0.3.0 (battery telemetry + Events panel + TEST injects)

**Tab:** AS3935 Tuning (`fe70cfdcdfa19aa4`)
**Source:** `vu2cpl-as3935-bridge/nodered/as3935-control-flow.json` (built from the bridge repo's `nodered/build-flow.py`, commit `8084ad9`).
**Added:** 13 nodes. **Updated:** Control Panel format, `as3935_tuning_replay_tick` wires.

Two pieces from the bridge's v0.3.0 build artifact ported into the
shack's actual flows.json:

1. **`AS3935 Control Panel` (`223cb2ce733c5d3f`) format updated** —
   picks up the new 🔋 battery row (mV reading + derived %SOC from a
   piecewise-linear LUT, green ≥ 3.90 V / amber 3.70–3.90 V / red <
   3.70 V, plus `(divider not wired?)` hint when reading < 500 mV),
   the new **Query Battery** action button, and the `vbat_offset_mv`
   tunable (±500 mV per-chip Vref trim). Existing node ID + position
   + wires preserved; only `format` field swapped.

2. **New `AS3935 Events` panel** alongside the Control Panel on the
   same dashboard tab (`c55b930b17a24bb1`, AS3935 Tuning). Shows a
   30-row rolling event log (from `lightning/as3935`) plus session
   counters (lightning / disturber / noise) plus a "Last Event"
   card backed by retained `lightning/as3935/last_event` (rehydrates
   on Node-RED restart within ~5 s). 5 TEST inject buttons publish
   synthetic events directly to `lightning/as3935` so the panel can
   be exercised end-to-end without involving the ESP32 — useful for
   styling tweaks, debouncing, etc.

**Dedupe handled by the importer.** Bridge build artifact also
contains the cache + replay infrastructure on the Tuning side
(`as3935_tuning_cache_status/hb/ack` + `as3935_tuning_replay_tick/fn`)
— these have identical IDs and contents to what's been in the shack
since 2026-05-14. Importer skipped them. Same for the Tuning-side
mqtt-in/out nodes which the shack has with its own pre-existing
IDs.

**Tick fan-out extended:** `as3935_tuning_replay_tick` now wires to
both `as3935_tuning_replay_fn` (existing, Control Panel) AND the new
`as3935_evt_replay_fn` (Events panel). One 5 s tick keeps both
panels populated.

**Operator action remaining** (not in this commit): the bridge's
ESP32 firmware needs the v0.3.0 binary flashed for `vbat_mv` to
actually arrive. **Done by the operator on 2026-05-17** before this
import. Battery row should populate within 30 s of dashboard load
(first `/hb` after restart) or immediately on Query Battery click.

### Lightning dashboard — hide RADIO tile when `radio_enabled` is false

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)
**Node:** Master Dashboard ui_template (`557083037f168b22`)
**Commit:** `df8ea41`

After yesterday's `RADIO_ENABLED = false` fix, the auto-disconnect
logic correctly stops touching the radio plug — but the Master
Dashboard's top switchBox still showed the **RADIO ON/OFF tile +
its RECONNECT button**. Misleading: the visible tile suggested the
radio was still being managed by lightning logic when it wasn't.

**Fix.** Two surgical edits to the dashboard ui_template:

1. HTML: the radio `<div class="sw-row">` (containing
   `#radioStatus` + the RECONNECT button) gets `id="radioRow"`.
2. JS: in `setStats(d)` (called every 10 s from the Stats refresh
   tick), prepend a display toggle:
   ```js
   var rr = document.getElementById('radioRow');
   if (rr) rr.style.display = d.radio_enabled ? '' : 'none';
   ```

`d.radio_enabled` is already populated by `Stats → Dashboard`
(`d1dca3df391cdfb8`), which reads `flow.get('radio_enabled')` set by
Init Defaults. No new wiring, no new nodes — just an HTML id + 2
lines of JS.

**Net effect when `RADIO_ENABLED = false`:**
- Top switchBox: only ANTENNA OFF/ON tile visible. RADIO tile +
  its RECONNECT button hidden. Bypass button stays — flex layout
  collapses the gap.
- Stats panel "Flex Radio" row was already gated by
  `if (d.radio_enabled) rows.push(...)` — also hidden. No change
  needed there.

**Net effect when `RADIO_ENABLED = true`:** unchanged from before.

**Worst-case rehydration** after a Deploy or browser refresh: up to
10 s (the Stats refresh tick interval). The row may briefly flash
visible at page load before the first tick runs. Acceptable; if it
ever becomes annoying, the toggle can be moved into the static
inline `<style>` block driven by a body class set on first message
arrival.

**`setRadio()` still runs on MQTT events** even when the row is
hidden — it updates the DOM element's class + text in the
background. So flipping `radio_enabled = true` back at runtime
shows the row immediately with current Tasmota state on the next
10 s tick — no stale flash.

---

## 2026-05-16

### Init Defaults — `RADIO_ENABLED = false`, `THRESHOLD_KM = 40` (operator preferences)

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)
**Node:** Init Defaults (`ec1fd4dece8c4dc0`)
**Commits:** `41c1708` (RADIO_ENABLED), `81ad69e` (THRESHOLD_KM)

Operator wanted only the antenna plug to be auto-disconnected on
lightning events (radio plug left alone), and the disconnect
threshold bumped from the 25 km default to 40 km. Two one-line edits.

**The road to `false` — a JavaScript-typing gotcha worth memorialising.**
First attempt was `const RADIO_ENABLED = 'false';` — the **string**
`'false'`, not the boolean `false`. Any non-empty string is truthy in
JavaScript, so:

```js
if (!flow.get('radio_enabled')) return null;
```

…evaluated `!'false'` → `false` → the gate stayed open and the radio
relay still got switched off on every disconnect. Audited every code
path; this was the only failure mode (no other node in the flow
publishes to the radio Tasmota's cmd topic). Fix: drop the quotes —
boolean literal. The Init Defaults blue-dot status text also relies
on truthy evaluation (`+(RADIO_ENABLED ? ' radio:'+... : '')`), so
with the string `'false'` the status text would still show the
`radio:...` segment — a useful diagnostic signal that the bug exists.

Hardening considered but skipped: tighter coercion in Init Defaults
(`flow.set('radio_enabled', RADIO_ENABLED === true)`) would have
caught the typo at compile time. Decided against it because the
existing call sites are clear, and the cost of strict coercion is
that future-Manoj typing `RADIO_ENABLED = 'true'` (string) would
*silently* disable the radio — same class of bug, different
direction. Better: rely on operator awareness + the
"how-to-edit-Init-Defaults" mental model.

### AS3935 sensor health alerts — 3-minute grace period before firing

**Tab:** Lightning Antenna Protector (`75e2cac8ab96f556`)
**Node:** `as3935_health_xition` (transition detector added 2026-05-15)
**Commit:** `ed260fe`

Operator was receiving paired Telegram alerts (`⚠ OFFLINE`,
`✓ ONLINE`) within a minute on routine network blips — WiFi
re-association, MQTT keepalive timeout + reconnect, brief ESP32
reboot. Real outages need alerts; brief flaps are noise.

**Asymmetric debounce** added to the transition detector:

- **Offline transition** → `setTimeout(graceMin × 60_000)` to fire
  the alert. If the sensor comes back online before the timer
  expires, `clearTimeout` and no alert fires.
- **Online transition** → cancels any pending offline timer. Only
  fires the recovery alert *if* the offline alert was actually sent
  (tracked via `context.alertedOffline`). Recovery from a non-
  reported outage is just noise.

Net effect:

| Outage duration | Alerts sent |
|---|---|
| < 3 min flap | 0 (silent) |
| 3 min and up | 1 OFFLINE at the 3-min mark, 1 ONLINE on recovery |

The grace period is **3 min** by default (`cfg_sensor_offline_grace_min`
in Init Defaults). Rationale: WiFi reconnect / MQTT keepalive
(60 s) + reconnect / ESP32 reboot + DHCP all complete in ≤ 2 min in
this shack. 3 min covers the common false-positive cases without
delaying real-outage notification beyond actionable time. Easy to
tune later if real-world experience shifts the optimal value.

Node statuses surface what's happening visually:

- Yellow ring `offline · pending 3m grace` → timer running, no alert
  sent yet
- Grey ring `flap recovered · no alert` → returned before timer
- Red dot `offline alert sent` → timer fired with sensor still down
- Green dot `online recovery alert sent` → paired recovery sent
  after a real outage

In-memory timer state (kept in `context.set('offlineTimer', t)`) is
wiped on Node-RED restart, which is fine: the `lastOffline === undefined`
first-sample guard at the top of the function suppresses the first
post-restart transition. No spurious alerts on flow restart.

### Operational lessons captured

Two recurring causes of confusion in this session, both written into
docs for next time:

1. **Editor view vs disk truth.** After a `git pull` while Node-RED
   is running, the editor reflects in-memory flow state, not the
   file on disk. New nodes pulled from origin don't appear in the
   editor until `sudo systemctl restart nodered`. Caught us today
   when the Telegram nodes were "missing" from the editor view even
   though grep confirmed they were on disk.

2. **Safari ≠ Chrome/Firefox shortcuts.** Wrote `Cmd+Shift+F` as a
   fit-to-view suggestion — that's Safari's fullscreen, not Node-
   RED's view-all. Added a universal rule to `~/.claude/CLAUDE.md`
   ("Browser + keyboard environment") to default to mouse/menu
   actions over keyboard shortcuts, and to verify any suggested
   shortcut against Safari on macOS specifically. The Node-RED
   navigation that always works: scroll the canvas with the
   trackpad. The minimap is via hamburger → View, when the version
   exposes it.

---

## Standard Commit Sequence (reminder)

Per CLAUDE.md rule #4, extract the DXCC Tracker tab alongside flows.json:

```bash
cd ~/.node-red/projects/vu2cpl-shack
python3 -c 'import json; d=json.load(open("flows.json")); v=[n for n in d if n.get("z")=="d110d176c0aad308" or n.get("id")=="d110d176c0aad308"]; json.dump(v,open("clublog_dxcc_tracker_v7.json","w"),indent=2)'
git add flows.json clublog_dxcc_tracker_v7.json
git commit -m "<description>"
git push
```

After push, on the Pi:

```bash
cd ~/.node-red/projects/vu2cpl-shack
git pull
sudo systemctl restart nodered
```
