# VU2CPL Shack Changelog

Fixes and changes to non-DXCC tabs of the Node-RED shack automation
(SPE amplifier, Power Control, Solar Conditions, Lightning, Rotator, etc.).

The DXCC Tracker has its own doc: see `README.md` / `DXCC_Tracker_README.pdf`.

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
