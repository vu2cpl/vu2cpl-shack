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
