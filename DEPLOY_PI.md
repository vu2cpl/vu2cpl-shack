# Deploy Pi monitoring to a new host

Step-by-step runbook for adding a new Raspberry Pi to the VU2CPL fleet.
Two components install together: an MQTT telemetry publisher and an HTTP
control agent. Once installed, the new host appears in the Node-RED RPi
Fleet panel automatically and accepts reboot/shutdown commands.

**Estimated time:** ~5 minutes per Pi.

---

## What gets installed

| Component | Path on Pi | Purpose |
|-----------|------------|---------|
| `monitor.sh` | `/home/vu2cpl/monitor.sh` | Reads CPU/mem/temp/disk/uptime/IP, publishes to `rpi/<hostname>/{cpu,mem,temp,disk,uptime,ip,status}` via `mosquitto_pub`. Cron-driven, every minute. |
| `rpi_agent.py` | `/home/vu2cpl/rpi_agent.py` | Tiny stdlib HTTP server on `:7799`. Two routes: `POST /reboot`, `POST /shutdown`. |
| `rpi-agent.service` | `/etc/systemd/system/rpi-agent.service` | systemd unit running `rpi_agent.py` as user `vu2cpl`. |
| sudoers entry | `/etc/sudoers.d/rpi-agent` | NOPASSWD allow for `vu2cpl` to call `/sbin/reboot` and `/sbin/shutdown`. |
| crontab entry | `vu2cpl` user crontab | `* * * * *  /home/vu2cpl/monitor.sh` |

---

## Prerequisites

- Target Pi has SSH access as user `vu2cpl` (key-based auth or password)
- Target Pi has internet (to `apt install` the MQTT client if missing)
- Target Pi's hostname is unique on the LAN (`hostname` command output)
- MQTT broker `192.168.1.169:1883` (Mosquitto on `noderedpi4`) is reachable
- Mac repo at `~/projects/vu2cpl-shack/` is up-to-date (`git pull` first)

For the entire runbook, set the target hostname or IP once and reuse:

```bash
TARGET=<new-pi-hostname-or-ip>      # e.g. raspberrypi5.local
```

---

## Step 1 — Copy files from Mac to the target Pi

From the Mac:

```bash
cd ~/projects/vu2cpl-shack
scp monitor.sh rpi_agent.py rpi-agent.service vu2cpl@$TARGET:/tmp/
```

Three files land in `/tmp/` on the target Pi.

---

## Step 2 — Install the files in canonical locations

SSH to the target Pi:

```bash
ssh vu2cpl@$TARGET
```

Then on the Pi:

```bash
# Move files into place
sudo cp /tmp/monitor.sh        /home/vu2cpl/monitor.sh
sudo cp /tmp/rpi_agent.py      /home/vu2cpl/rpi_agent.py
sudo cp /tmp/rpi-agent.service /etc/systemd/system/rpi-agent.service

# Reset ownership so vu2cpl owns the user-space scripts (not root)
# This is the gotcha that bit us 2026-05-07 — sudo cp leaves files root-owned.
sudo chown vu2cpl:vu2cpl /home/vu2cpl/monitor.sh /home/vu2cpl/rpi_agent.py
sudo chmod +x /home/vu2cpl/monitor.sh

# Clean up
rm /tmp/monitor.sh /tmp/rpi_agent.py /tmp/rpi-agent.service

# Verify ownership
ls -la /home/vu2cpl/monitor.sh /home/vu2cpl/rpi_agent.py
# Expect: -rwxr-xr-x vu2cpl vu2cpl … monitor.sh
#         -rw-r--r-- vu2cpl vu2cpl … rpi_agent.py
```

---

## Step 3 — Install MQTT client + smoke-test telemetry

```bash
# mosquitto-clients provides mosquitto_pub / mosquitto_sub
which mosquitto_pub || sudo apt update && sudo apt install -y mosquitto-clients

# Run monitor.sh once and watch what arrives on the broker
/home/vu2cpl/monitor.sh
mosquitto_sub -h 192.168.1.169 -t "rpi/$(hostname)/#" -v -C 7
```

You should see 7 lines like:

```
rpi/<hostname>/cpu     12
rpi/<hostname>/mem     34
rpi/<hostname>/temp    45.2
rpi/<hostname>/disk    18
rpi/<hostname>/uptime  up 2 hours, 14 minutes
rpi/<hostname>/ip      192.168.1.x
rpi/<hostname>/status  online
```

If `mosquitto_sub` hangs, check broker reachability: `nc -zv 192.168.1.169 1883`.

---

## Step 4 — Schedule monitor.sh in cron

```bash
# Idempotent append — won't double up on re-run
(crontab -l 2>/dev/null | grep -v 'monitor.sh' ; \
 echo '* * * * *  /home/vu2cpl/monitor.sh') | crontab -

# Verify
crontab -l | grep monitor.sh
# Expect exactly one line: * * * * *  /home/vu2cpl/monitor.sh
```

Wait 60 s, then re-run `mosquitto_sub` — you should see the next batch
arrive automatically.

---

## Step 5 — Sudoers for reboot/shutdown

The agent script does `subprocess.Popen(['sudo', 'reboot'])` from a
non-root user. Without NOPASSWD, the call would prompt and hang.

```bash
echo 'vu2cpl ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown' | \
  sudo tee /etc/sudoers.d/rpi-agent
sudo chmod 440 /etc/sudoers.d/rpi-agent

# Syntax check — must print "parsed OK"
sudo visudo -c
```

If `visudo -c` fails, fix the sudoers entry before continuing — a broken
sudoers file can lock you out of `sudo` entirely.

---

## Step 6 — Enable and start rpi-agent

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rpi-agent
sudo systemctl status rpi-agent --no-pager
# Expect: active (running)
```

Smoke-test the HTTP endpoint without actually rebooting:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" -X POST http://localhost:7799/probe
# Expect: 404
# (Any path that isn't /reboot or /shutdown returns 404 → confirms server is alive)
```

---

## Step 7 — Register the new Pi in Node-RED

Open Node-RED editor at `http://192.168.1.169:1880`, navigate to the
**RPi Fleet Monitor** tab, open the function node **Route CMD: HTTP or
MQTT** (id `a0695975fec84e2c`).

Add the new host to the `httpDevices` map:

```javascript
var httpDevices = {
    'noderedpi4':    'http://noderedpi4.local:7799',
    'openwebrxplus': 'http://openwebrxplus.local:7799',
    '<NEW-HOSTNAME>': 'http://<NEW-HOSTNAME>.local:7799'   // ← add this line
};
```

(Use whatever hostname `hostname` returned on the target Pi.)

Click **Done** → **Deploy** (Modified Nodes is fine).

On the Pi (`noderedpi4`), commit the flow change:

```bash
nrsave "RPi Fleet: add <NEW-HOSTNAME> to httpDevices"
git push
```

Then on the Mac, `git pull` to stay in sync.

---

## Step 8 — Verify in the dashboard

Browser → Shack tab → **RPi Fleet** panel. Within 60 s the new host
appears with live CPU / temp / mem / disk values.

To test the control side:
1. Click **Reboot** next to the new host → confirm in the modal.
2. Watch the agent service log on the Pi: `sudo journalctl -u rpi-agent -f`.
3. The Pi should reboot. After it comes back, the panel re-populates
   automatically (cron fires within a minute, telemetry resumes).

---

## Special cases

### Home Assistant Pi (HassPi)

HA Pi does **not** use `monitor.sh` or `rpi_agent.py`. Instead, an
HA-side automation publishes the same `rpi/HassPi/*` topics every 30 s
via HA's `mqtt.publish` service. No deployment needed on the HA Pi
itself; just confirm the topics are flowing with `mosquitto_sub -h
192.168.1.169 -t 'rpi/HassPi/#' -v`.

Reboot/shutdown for HassPi can be wired through HA's REST API later
(HANDOVER follow-up #4 — Bearer token).

### Pis without `mosquitto-clients` available in apt

Some minimal RaspiOS images don't have `mosquitto-clients` in their
default repos. Add it with:

```bash
sudo apt update
sudo apt install -y mosquitto-clients
```

If still unavailable, install Mosquitto's official repo first per
https://mosquitto.org/download/ — but this is rare.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `cp: cannot create regular file '/home/vu2cpl/...'` | File is root-owned from a previous `sudo` edit (the 2026-05-07 quirk) | `sudo cp + sudo chown vu2cpl:vu2cpl` |
| Telemetry never arrives at broker | Pi can't reach `192.168.1.169:1883` | `nc -zv 192.168.1.169 1883` |
| Telemetry arrives once, then stops | Cron isn't running | `sudo systemctl status cron` |
| `rpi-agent` won't start | sudoers syntax error or wrong path in unit file | `sudo journalctl -u rpi-agent -n 50` |
| `curl http://localhost:7799/probe` connection refused | Service not started, or another process on port 7799 | `sudo ss -tnlp \| grep 7799` |
| Reboot button does nothing | `vu2cpl` not allowed sudo reboot | `sudo -l \| grep reboot` should show NOPASSWD |
| Dashboard shows host once then "offline" | `monitor.sh` only ran during install; cron isn't firing | check `crontab -l` and `sudo systemctl status cron` |

---

## Removing a Pi from the fleet

If a Pi is being decommissioned:

1. On the Pi: stop and disable services
   ```bash
   sudo systemctl disable --now rpi-agent
   sudo rm /etc/systemd/system/rpi-agent.service
   sudo rm /etc/sudoers.d/rpi-agent
   crontab -l | grep -v 'monitor.sh' | crontab -
   rm /home/vu2cpl/monitor.sh /home/vu2cpl/rpi_agent.py
   ```
2. Last `monitor.sh` run already published `status: online` — to mark
   it offline cleanly, publish a final `offline` status (optional):
   ```bash
   mosquitto_pub -h 192.168.1.169 -t "rpi/$(hostname)/status" -m "offline"
   ```
3. In Node-RED, remove the host from `httpDevices` in
   `Route CMD: HTTP or MQTT`. Deploy. `nrsave` and push.
4. The dashboard's `Detect Offline Devices` watchdog will eventually
   age the host out of the panel anyway, but explicit removal is
   cleaner.

---

*See also: [CLAUDE.md](CLAUDE.md) §RPi Fleet Monitor — a shorter
quick-reference of the same install commands.*
