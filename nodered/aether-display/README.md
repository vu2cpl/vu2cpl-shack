# AetherSDR MQTT display — humanized shack status

Shows live shack status on the AetherSDR panadapter overlay:

```
Antenna: ON          Lightning: Disturber, 3 min ago
AS3935: Active       GPS: S1 +9 ns
Power: 100 W         SWR: 1.20:1
```

## Design goal — no AetherSDR code changes, ever

**All formatting happens outside AetherSDR, in Node-RED.** The raw shack
topics (`stat/powerstrip1/POWER5`, `lightning/as3935/*`,
`shack/gpsntp/chrony`) carry machine values — `ON`, JSON blobs, offsets
in seconds. A Node-RED flow subscribes to those, formats them into
human-readable one-liners, and **re-publishes them retained** under a
dedicated `aether/*` topic tree.

AetherSDR only ever subscribes to `aether/*` and prints
`topic-leaf: payload` verbatim. It never parses JSON, never knows a
sensor's units, never needs a build to track a payload change. When a
sensor's raw format changes, you fix the one Node-RED function — the app
is untouched. This is what makes the display survive every future
AetherSDR release with config only.

```
 Tasmota / AS3935 / chrony ──raw──▶ Node-RED "AetherSDR Display" flow
                                        │  (humanize + retain)
                                        ▼
                                   aether/Antenna   "ON"
                                   aether/Lightning "Disturber, 3 min ago"
                                   aether/AS3935    "Active"
                                   aether/GPS       "S1 +9 ns"
                                   aether/Power     "100 W"
                                   aether/SWR       "1.20:1"
                                        │
                                        ▼
                            AetherSDR MqttApplet (subscribe only)
```

## Topic → format reference

| `aether/*` topic | Source (raw) | Example payload |
|---|---|---|
| `aether/Antenna`  | `stat/powerstrip1/POWER5` (Tasmota) | `ON` / `OFF` |
| `aether/Lightning`| `lightning/as3935/last_event` (JSON) | `Disturber, 3 min ago` |
| `aether/AS3935`   | `lightning/as3935/status` (JSON + LWT) | `Active` / `Offline` |
| `aether/GPS`      | `shack/gpsntp/chrony` (JSON) | `S1 +9 ns` |
| `aether/Power`    | Node-RED `lpState.avg` (LP-700 WebSocket) | `100 W` |
| `aether/SWR`      | Node-RED `lpState.swr` (LP-700 WebSocket) | `1.20:1` |

All six are published **retained**, so AetherSDR shows the last known
value the instant it connects, without waiting for the next update.

## Broker account — least privilege

AetherSDR authenticates with a dedicated **`display`** account that can
**read `aether/#` and nothing else** (added to `/etc/mosquitto/passwd`
and `/etc/mosquitto/aclfile` on the `192.168.1.169` broker, 2026-08-21):

```
# /etc/mosquitto/aclfile
user display
topic read aether/#
```

This keeps the broad `nodered`/`ha` credentials out of AetherSDR's
on-disk `QSettings`. The Node-RED flow publishes `aether/*` using the
existing `nodered` account (`readwrite #`), so no publish-side ACL
change was needed. See [`../../MQTT_AUTH.md`](../../MQTT_AUTH.md) for the full account
model.

## Install

### 1. Import the Node-RED flow

In a **fresh** Node-RED editor tab (avoid a stale tab — a stale tab can
revert other flows on deploy), at `http://192.168.1.169:1880`:

1. Hamburger menu → **Import** → paste the contents of
   [`aether-display-flow.json`](aether-display-flow.json) → **Import**.
2. It lands as a new tab **"AetherSDR Display"** (4 MQTT inputs → a
   `Humanize -> aether` function → one `aether/*` MQTT output, plus a
   2-second timer feeding `LP-700 -> aether`).
3. **Deploy.**

The four MQTT-sourced values (`Antenna`, `Lightning`, `AS3935`, `GPS`)
work immediately after deploy.

### 2. Expose LP-700 state to the flow (one line)

LP-700 power/SWR is **not on MQTT** — it arrives over
`ws://lp700-server/ws` and lives in the LP-700 tab's flow context
(`flow.lpState`). Flow context is per-tab, so the new tab can't read it.
Expose it to global context with a one-line edit **on the same fresh
deploy**:

1. Open the **`LP State Aggregator`** function (LP-700-HID ws tab).
2. Find `flow.set('lpState', st);` and add immediately after it:

   ```js
   global.set('lpState', st);   // mirror for AetherSDR Display flow
   ```
3. **Deploy.** `aether/Power` and `aether/SWR` now populate.

`LP-700 -> aether` publishes `lpState.avg` as watts and `lpState.swr` as
`x.xx:1` every 2 s (retained). To show peak instead of average watts,
change `s.avg` to `s.peak` in that function.

### 3. Configure AetherSDR

In AetherSDR's MQTT applet settings:

| Setting | Value |
|---|---|
| Host | `192.168.1.169` |
| Port | `1883` |
| User | `display` |
| Password | *(the `display` account password)* |
| TLS | off |
| Topics | `*aether/Antenna, *aether/Lightning, *aether/AS3935, *aether/GPS, *aether/Power, *aether/SWR` |

The leading `*` on each topic flags it for the **panadapter overlay**
(`displayOnPan`) rather than the message log only. AetherSDR shows the
last topic segment as the label and the payload as the value — e.g.
`Antenna: ON`.

## Changing a format later

Everything is in the Node-RED `Humanize -> aether` function (and
`LP-700 -> aether` for power/SWR). Edit the string, Deploy — AetherSDR
picks up the new retained value on the next publish. No rebuild, no app
config change.

## Gotcha — mqtt-in "auto-detect" hands you an object, not a string

The four `mqtt in` nodes use `datatype: auto-detect`, so Node-RED
**already parses** the JSON topics (`chrony`, `as3935/status`,
`last_event`) into JavaScript objects before they reach the function.
Plain topics (`POWER5` = `ON`) stay strings. So the function must **not**
blindly `JSON.parse(msg.payload)` — that throws on the already-parsed
object, and the `try/catch` swallows it, leaving those `aether/*` topics
silently unpublished (only `Antenna` and the global-sourced `Power`
appear). The shipped `obj()` helper normalises object / string / Buffer
to an object. If you rebuild the function by hand, keep that helper.
