# Shack MQTT Authentication

**As-built 2026-08-21.** The shack Mosquitto broker (`192.168.1.169:1883`,
also TLS `:8883` and websockets `:9001`) **no longer accepts anonymous
connections.** Every client authenticates with one of the role accounts,
and an ACL scopes each account to the topics it needs.

> Security analysis and the migration story live in the (private)
> `vlan-setup` repo's `SECURITY-AUDIT.md` (finding **H1**). This file is the
> operational reference: what the accounts are, what each client uses, and
> how to onboard or rotate one. **No passwords are stored here** — they live
> in the shack password manager.

---

## Accounts

| Account | Used by | ACL scope |
|---|---|---|
| `iot` | 9 Tasmota power devices + the as3935 lightning bridge | read `cmnd/#`; write `tele/#`, `stat/#`; read+write `tasmota/#`, `lightning/#`. **Cannot** read services topics (`rpi/`, `shack/`, `ubersdr/`) or `$SYS`. |
| `svc` | Pi telemetry publishers: `monitor.sh` (rpi metrics), `gpsntp-mqtt-publish.sh` (chrony), `solar_inverter_mqtt.py` (Deye inverter), ubersdr | read+write `rpi/#`, `shack/#`, `ubersdr/#` only |
| `nodered` | Node-RED (the dashboard + automation controller) | read+write `#` (everything except `$SYS`) |
| `ha` | Home Assistant | read+write `#` (everything except `$SYS`) |
| `display` | AetherSDR panadapter status overlay | **read `aether/#` only** — the humanized status tree Node-RED publishes. Nothing else. |

The `iot` scoping is the point of the ACL: a compromised IoT device holds
the `iot` credential but still cannot read the rest of the shack or command
other device classes.

`$SYS` is denied to **all** accounts (mosquitto excludes it from `#`). No
flow needs it today; if a broker-stats widget is ever added to Node-RED,
grant `topic read $SYS/#` to `nodered` in the ACL.

---

## Broker configuration (on `192.168.1.169`)

All under `/etc/mosquitto/` — **not** version-controlled, so back it up
(the `passwd` hashes + ACL are the only copies):

- `conf.d/00-auth.conf` — `password_file /etc/mosquitto/passwd` +
  `acl_file /etc/mosquitto/aclfile` (loads before the listener files).
- `passwd` — the accounts, `mosquitto_passwd`-hashed (`$7$` sha512-pbkdf2).
  Owned `root:mosquitto`, `chmod 640` (root-owned satisfies the ownership
  check newer mosquitto enforces; the `mosquitto` group makes it readable
  by the broker process, which runs as user `mosquitto`). **Do not** make
  it `root:root 600` — the broker can't read it and *all new auth fails*
  (existing persistent connections survive, so it looks fine until a
  device reconnects). Learned 2026-08-21.
- `aclfile` — the per-account `topic` rules above. Same ownership/mode.
- `conf.d/{lan,tls,websockets}.conf` — the three listeners, each
  `allow_anonymous false`.

Reload after a `passwd`/`aclfile` change: `sudo systemctl reload mosquitto`
(SIGHUP re-reads both files **without** dropping connected clients).
A full `restart` is only needed for listener/`conf.d` changes.

---

## Per-client configuration

| Client | Account | Where the credential is set |
|---|---|---|
| **Tasmota** ×9 | `iot` | Console/web `MqttUser` + `MqttPassword`, or over MQTT: `cmnd/<device>/Backlog MqttUser iot; MqttPassword <pw>` |
| **as3935 bridge** | `iot` | WiFiManager captive-portal fields (firmware ≥ v0.4.0), persisted in NVS. See the `vu2cpl-as3935-bridge` repo. |
| **Home Assistant** | `ha` | HA → Settings → Devices → MQTT integration → reconfigure |
| **Node-RED** | `nodered` | The `mqtt-broker` config node's *Security* tab. Stored in the project's `flows_cred.json` (**encrypted** — see below). |
| **`monitor.sh`** (rpi metrics) | `svc` | `MQTT_USER`/`MQTT_PASS` in `/etc/default/vu2cpl-shack` **or** the per-user `~/.config/vu2cpl-shack.env` (no-sudo fallback, `chmod 600`). `rebuild_pi.sh` writes the `/etc/default` one. |
| **`solar_inverter_mqtt.py`** (Deye inverter → `shack/solar/inverter`) | `svc` | Same two credential files as `monitor.sh` (parsed, not sourced — it's Python). |
| **`gpsntp-mqtt-publish.sh`** (chrony) | `svc` | `MQTT_USER`/`MQTT_PASS` env lines in `/etc/cron.d/gpsntp-mqtt` (runs as root). `install.sh` in `pi-gps-ntp-server` writes them. |
| **ubersdr** | `svc` | ubersdr's own web UI |
| **AetherSDR** | `display` | MQTT applet settings (host/user/pass + `aether/*` topics). Reads the humanized status tree only. See [`nodered/aether-display/`](nodered/aether-display/). |

### Non-MQTT secrets in the same env files

`~/.config/vu2cpl-shack.env` is not only an MQTT file. Since
2026-08-29 it also carries **`TELEGRAM_TOKEN` / `TELEGRAM_CHAT_ID`**
for the shack bot, read by `stabiliser_watch.py` and `flows_guard.py`
so their alerts survive Node-RED being down (both previously read the
token out of the running Node-RED process, and so went silent exactly
when the shack was least healthy).

Consequences worth keeping in mind:

- The file is **mode 600, user-owned**, in a `700` home. Create it
  `0600` from the outset — do not `chmod` after writing, or the token
  is briefly world-readable.
- It is **not in the repo and not written by `rebuild_pi.sh`**. A
  rebuilt Pi has no token until the file is hand-written; see
  REBUILD_PI.md.
- **This repo is public.** Never paste the token into a commit, an
  issue, or an assistant session — write it Pi-side with a heredoc
  under `umask 077` so it misses shell history too. A token that has
  been echoed anywhere should be rotated via BotFather.
- The Mac-side file of the same name additionally holds `HA_URL` /
  `HA_TOKEN` for the Home Assistant REST API. Same rules.

### Node-RED credential encryption

`flows_cred.json` is now **encrypted** (project `credentialSecret` in
`~/.node-red/.config.projects.json` on the Pi — outside the repo) and is
**gitignored** so no credential blob ships in this public repo. **Back up
that `credentialSecret`** — losing it makes the stored creds undecryptable.

---

## Onboarding a new client

1. Pick the right account (usually `iot` for a device, `svc` for a Pi-side
   publisher). Confirm the ACL already covers its topics — if not, add a
   `topic` line under that account in `/etc/mosquitto/aclfile` and restart
   mosquitto.
2. Configure the client with that account's username + password (from the
   password manager) per the table above.
3. Verify it connects and its topics flow. While anonymous is disabled, a
   missing/wrong credential shows as `not authorised` in
   `/var/log/mosquitto/mosquitto.log`.

## Rotating a password

```bash
# on 192.168.1.169
sudo mosquitto_passwd -b /etc/mosquitto/passwd <account> '<new-password>'
sudo systemctl restart mosquitto
```
Then update every client on that account (and the password manager). For
`svc`, that's the env files on each Pi + ubersdr's UI; for `iot`, the
Tasmota `Backlog` push + the as3935 portal.
