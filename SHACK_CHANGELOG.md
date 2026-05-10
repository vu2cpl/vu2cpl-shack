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
