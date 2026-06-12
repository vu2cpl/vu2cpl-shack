# Fork fix — sweeping the `192.168.1.169` broker hardcodes

**Problem:** "MQTT not working at a new site." An earlier fix made
`rebuild_pi.sh` Stage 7 rewrite the two `mqtt-broker` *config nodes* in
`flows.json` to the fork's broker IP — but the shipped `192.168.1.169`
literal still survived in several other places, so a fork at a different IP
had broken telemetry, a broken LP-700 link, and a misleading Init Defaults
value.

## Where `.169` was still hardcoded

| Location | Type | Fix |
| --- | --- | --- |
| `monitor.sh` | `BROKER=192.168.1.169` | now reads `$MQTT_BROKER` → `/etc/default/vu2cpl-shack` → `127.0.0.1` |
| `as3935_mqtt.py` | `MQTT_BROKER = "192.168.1.169"` | now `os.environ.get("MQTT_BROKER","127.0.0.1")` |
| `as3935.service` | (no broker source) | `EnvironmentFile=-/etc/default/vu2cpl-shack` (+ `PYTHONUNBUFFERED=1`) |
| `flows.json` LP-700 ws-client `lp7wsclient00001` | `path: ws://192.168.1.169:8089/ws` | Stage 7 rewrites the host to `localhost` (the gateway runs on the same Pi — like the SPE/rotator ws-clients already do) |
| `flows.json` Init Defaults `MQTT_BROKER` const | `'192.168.1.169'` | Stage 7 rewrites to the broker IP |
| `as3935.service` / `rpi-agent.service` | `User=vu2cpl`, `/home/vu2cpl/…` | Stage 9 sed-retargets `vu2cpl` → `$ACTUAL_USER` at install |

## What the install now does

- **Inventory** (mandatory, up front) collects the broker IP as `MQTT_IP`
  (default = the Pi's own LAN IP).
- **Stage 7** sweeps `flows.json`: broker config nodes → `MQTT_IP`;
  every `websocket-client` path's `.169` → `localhost`; Init Defaults
  const → `MQTT_IP`. Then a **fail-loud residual sweep**: if any
  `192.168.1.169` survives (and the target isn't itself `.169`), the stage
  aborts — a missed hardcode means broken MQTT.
- **Stage 9** writes `/etc/default/vu2cpl-shack` (`MQTT_BROKER=<ip>`),
  consumed by `as3935.service` (EnvironmentFile) and `monitor.sh` (sourced,
  since cron can't use EnvironmentFile), and retargets both systemd units'
  user/home to `$ACTUAL_USER`.

The repo's `flows.json` is deliberately **left at `.169`** (VU2CPL's own
value); Stage 7 rewrites it at install time — so there is no `flows.json`
change in this commit.

## Fixing an ALREADY-broken fork (without a full re-run)

```bash
# 1. point the broker + LP-700 ws-client at the right host, in the editor:
#    Node-RED editor → any mqtt node → pencil-edit broker config → Server = <pi IP or 127.0.0.1>
#    LP-700-HID ws tab → ws-client config (lp7wsclient00001) → URL = ws://localhost:8089/ws
#    Deploy.
# 2. for the Pi-side scripts:
echo "MQTT_BROKER=<pi-ip-or-127.0.0.1>" | sudo tee /etc/default/vu2cpl-shack
sudo systemctl restart as3935 2>/dev/null || true   # if you run the Pi AS3935 daemon
# monitor.sh picks it up on its next cron tick.
```
Or, on the latest script: `bash rebuild_pi.sh --stage 7` (sweeps flows.json)
and `bash rebuild_pi.sh --stage 9` (writes the env file + retargets units).

## Verification

```bash
# no .169 should remain in the deployed flow (on a non-.169 site):
grep -c 192.168.1.169 ~/.node-red/projects/vu2cpl-shack/flows.json   # -> 0
cat /etc/default/vu2cpl-shack                                         # MQTT_BROKER=<your ip>
systemctl cat as3935 | grep -E "EnvironmentFile|User="               # env file + your user
# telemetry flows to the broker:
mosquitto_sub -h <broker-ip> -t "rpi/$(hostname)/cpu" -C 1
```

*73 de VU2CPL*
