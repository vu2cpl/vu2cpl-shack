#!/usr/bin/env python3
"""Deye solar inverter -> MQTT telemetry publisher.

Reads the Deye SG0*LP3 (LV 3-phase hybrid) via its Solarman V5 WiFi
logger and publishes one retained JSON to shack/solar/inverter on the
shack broker. Cron-driven every minute from the vu2cpl crontab on
noderedpi4, alongside monitor.sh.

The logger tolerates only a couple of concurrent TCP clients and Home
Assistant polls it too, so each run is a quick connect->read->disconnect
(two register reads, ~0.5 s) with one retry, and exits silently on a
collision — the retained message stands and the dashboards grey the
line out when `ts` goes stale.

MQTT auth: svc account, credentials from /etc/default/vu2cpl-shack
(MQTT_USER / MQTT_PASS / optionally MQTT_BROKER) or the no-sudo
fallback ~/.config/vu2cpl-shack.env — same contract as monitor.sh.

Deps: pysolarmanv5 (pip3 install --user --break-system-packages
pysolarmanv5), mosquitto-clients (mosquitto_pub).
"""

import json
import os
import subprocess
import sys
import time

# --- Inverter (Deye LV 3-phase hybrid, Solarman LSW logger) ---------------
INVERTER_IP = "192.168.30.193"
LOGGER_SERIAL = 2924751994
MODBUS_SLAVE = 1

# --- MQTT -----------------------------------------------------------------
TOPIC = "shack/solar/inverter"
DEFAULT_BROKER = "192.168.1.169"
ENV_FILES = ("/etc/default/vu2cpl-shack",
             os.path.expanduser("~/.config/vu2cpl-shack.env"))


def load_env():
    """Parse KEY=VALUE lines from the monitor.sh credential files."""
    env = {}
    for path in ENV_FILES:
        try:
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
        except OSError:
            continue
    return env


def signed16(v):
    return v - 65536 if v > 32767 else v


def read_inverter():
    from pysolarmanv5 import PySolarmanV5
    m = PySolarmanV5(INVERTER_IP, LOGGER_SERIAL, port=8899,
                     mb_slave_id=MODBUS_SLAVE, socket_timeout=10)
    try:
        # 586 batt temp (offset 1000, x0.1C) · 587 batt V (x0.01V)
        # 588 SOC % · 590 batt power (signed W, negative = charging)
        # 591 batt current (signed, x0.01A)
        b = m.read_holding_registers(586, 6)
        # 598-600 grid phase voltages L1/L2/L3 (x0.1V)
        g = m.read_holding_registers(598, 3)
    finally:
        try:
            m.disconnect()
        except Exception:
            pass

    batt_p = signed16(b[4])
    grid_v = [round(v / 10.0, 1) for v in g]
    if batt_p < -25:
        batt_state = "charging"
    elif batt_p > 25:
        batt_state = "discharging"
    else:
        batt_state = "idle"
    return {
        "ts": int(time.time()),
        "grid_on": any(v > 80 for v in grid_v),
        "grid_v": grid_v,
        "batt_soc": b[2],
        "batt_p_w": batt_p,
        "batt_state": batt_state,
        "batt_v": round(b[1] / 100.0, 2),
        "batt_i_a": round(signed16(b[5]) / 100.0, 2),
        "batt_temp_c": round((b[0] - 1000) / 10.0, 1),
    }


def main():
    verbose = "--verbose" in sys.argv
    data = None
    for attempt in (1, 2):
        try:
            data = read_inverter()
            break
        except Exception as e:
            if verbose:
                print(f"read attempt {attempt} failed: {e}", file=sys.stderr)
            time.sleep(2)
    if data is None:
        # Likely a collision with HA's poll — stay silent, retained value stands.
        sys.exit(0)

    env = load_env()
    broker = env.get("MQTT_BROKER", DEFAULT_BROKER)
    cmd = ["mosquitto_pub", "-h", broker, "-t", TOPIC, "-r",
           "-m", json.dumps(data, separators=(",", ":"))]
    if env.get("MQTT_USER"):
        cmd += ["-u", env["MQTT_USER"], "-P", env.get("MQTT_PASS", "")]
    subprocess.run(cmd, check=False)
    if verbose:
        print(json.dumps(data, indent=2))


if __name__ == "__main__":
    main()
