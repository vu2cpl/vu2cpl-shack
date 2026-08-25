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

It also appends one row per run to ~/grid_voltage.csv — the only
historical record of grid voltage in the shack, since the MQTT message
is retained (last value only) and nothing else stores a time series.
Added 2026-08-25 to build an evidence file for the supply utility about
nightly over-voltage; see grid_voltage_report.py for the analysis side.

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

# --- Historical log -------------------------------------------------------
# One row per run. This is the ONLY time series of grid voltage in the
# shack — the MQTT message is retained, i.e. last value only.
#
# IMPORTANT for anyone reading this file as evidence: the inverter's grid
# input sits DOWNSTREAM of the servo stabiliser (operator-confirmed
# 2026-08-25). The rows therefore show true incoming mains only while the
# stabiliser is in BYPASS; with it engaged they show its regulated ~220 V
# output instead. Record bypass windows alongside the data.
LOG_PATH = os.path.expanduser("~/grid_voltage.csv")
LOG_HEADER = ("ts_iso,ts_epoch,status,l1_v,l2_v,l3_v,"
              "grid_on,batt_soc,batt_p_w\n")

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


def append_log(data):
    """Append one CSV row. Never raise — logging must not break publishing.

    A failed read still gets a row (status=read_fail) with empty readings:
    a bare gap in timestamps can't distinguish "logger busy / collision"
    from "the whole site lost power", and that distinction is the point of
    the file.
    """
    try:
        # One instant per row: the read's own timestamp when we have one.
        epoch = int(data["ts"]) if data else int(time.time())
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(epoch))
        if data is None:
            row = "%s,%d,read_fail,,,,,,\n" % (stamp, epoch)
        else:
            v = data["grid_v"]
            row = "%s,%d,ok,%s,%s,%s,%d,%s,%d\n" % (
                stamp, epoch, v[0], v[1], v[2],
                1 if data["grid_on"] else 0, data["batt_soc"],
                data["batt_p_w"])
        new_file = not os.path.exists(LOG_PATH)
        with open(LOG_PATH, "a") as f:
            if new_file:
                f.write(LOG_HEADER)
            f.write(row)
    except Exception:
        pass


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
        # Likely a collision with HA's poll — stay silent, retained value
        # stands. Still log the gap so outages are distinguishable later.
        append_log(None)
        sys.exit(0)

    append_log(data)

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
