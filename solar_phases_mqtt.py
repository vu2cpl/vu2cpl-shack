#!/usr/bin/env python3
"""Deye inverter per-phase load -> MQTT, every few seconds (daemon).

Companion to solar_inverter_mqtt.py (the 1-min cron that keeps the
retained shack/solar/inverter message and the grid_voltage.csv evidence
file). This one feeds the dashboards' live per-phase load graph, which a
1-min cadence can't do: it holds ONE connection to the Solarman logger
and every INTERVAL seconds reads

    598-600  grid voltage L1/L2/L3           (x0.1 V)
    586-591  battery temp/V/SOC/power/current
    650-653  load power L1/L2/L3 + total     (W; UPS side + SmartLoad port)
    664-667  SmartLoad port power L1/L2/L3 + total (W)

and publishes one retained JSON to shack/solar/phases:

    {"ts":…, "grid_on":true, "grid_v":[233.1,234.0,232.8],
     "load":[0,892,10], "smartload":[0,0,10], "ups":[0,892,0],
     "load_total":904, "soc":100, "batt_p_w":-5}

`ups` = load - smartload per phase (what HA shows as load_ups_lX_power).
Register map verified 2026-10-19 16:21 IST against HA's Solarman
sensors at the same instant (CLAUDE.md "Grid-loss load shedding").

The logger tolerates only a couple of TCP clients (HA holds one). On any
read error the socket is dropped and reopened with backoff; after
MAX_FAILS consecutive failures the poll interval doubles up to 20 s so a
busy logger is left alone. Nothing is published on failure — the retained
message stands and the dashboards grey the tile out when `ts` goes stale.

MQTT: svc account, credentials from /etc/default/vu2cpl-shack or
~/.config/vu2cpl-shack.env (same contract as monitor.sh). Deps:
pysolarmanv5, paho-mqtt (both already on noderedpi4).

Runs as solar-phases.service on noderedpi4 (see the unit next to this
file). `--once --verbose` prints one reading and exits, for a quick check.
"""

import json
import os
import signal
import sys
import time

INVERTER_IP = "192.168.30.193"
LOGGER_SERIAL = 2924751994
MODBUS_SLAVE = 1
INTERVAL = 5            # s between reads when healthy
MAX_INTERVAL = 20       # s, after repeated failures
MAX_FAILS = 3           # consecutive failures before backing off

TOPIC = "shack/solar/phases"
DEFAULT_BROKER = "192.168.1.169"
ENV_FILES = ("/etc/default/vu2cpl-shack",
             os.path.expanduser("~/.config/vu2cpl-shack.env"))


def load_env():
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


class Inverter:
    def __init__(self):
        self.m = None

    def connect(self):
        from pysolarmanv5 import PySolarmanV5
        self.m = PySolarmanV5(INVERTER_IP, LOGGER_SERIAL, port=8899,
                              mb_slave_id=MODBUS_SLAVE, socket_timeout=8,
                              auto_reconnect=False)

    def close(self):
        if self.m is not None:
            try:
                self.m.disconnect()
            except Exception:
                pass
            self.m = None

    def read(self):
        if self.m is None:
            self.connect()
        g = self.m.read_holding_registers(598, 3)
        b = self.m.read_holding_registers(586, 6)
        l = self.m.read_holding_registers(650, 4)
        s = self.m.read_holding_registers(664, 4)
        load = [signed16(v) for v in l[:3]]
        sl = [signed16(v) for v in s[:3]]
        grid_v = [round(v / 10.0, 1) for v in g]
        return {
            "ts": int(time.time()),
            "grid_on": any(v > 80 for v in grid_v),
            "grid_v": grid_v,
            "load": load,
            "smartload": sl,
            "ups": [max(0, a - c) for a, c in zip(load, sl)],
            "load_total": signed16(l[3]),
            "smartload_total": signed16(s[3]),
            "soc": b[2],
            "batt_p_w": signed16(b[4]),
        }


def make_mqtt(env):
    import paho.mqtt.client as mqtt
    try:
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="solar-phases")
    except AttributeError:          # paho 1.x
        c = mqtt.Client(client_id="solar-phases")
    if env.get("MQTT_USER"):
        c.username_pw_set(env["MQTT_USER"], env.get("MQTT_PASS", ""))
    c.connect(env.get("MQTT_BROKER", DEFAULT_BROKER), 1883, keepalive=60)
    c.loop_start()
    return c


def main():
    once = "--once" in sys.argv
    verbose = "--verbose" in sys.argv or once
    env = load_env()
    inv = Inverter()
    client = None if once else make_mqtt(env)
    running = True

    def stop(*_):
        nonlocal running
        running = False
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    fails = 0
    interval = INTERVAL
    while running:
        t0 = time.time()
        try:
            data = inv.read()
            fails = 0
            interval = INTERVAL
            if verbose:
                print(json.dumps(data), flush=True)
            if client is not None:
                client.publish(TOPIC, json.dumps(data, separators=(",", ":")),
                               qos=0, retain=True)
            if once:
                break
        except Exception as e:
            fails += 1
            inv.close()
            if fails >= MAX_FAILS:
                interval = min(MAX_INTERVAL, interval * 2)
            print("read failed (%d): %s — next in %ds" % (fails, e, interval),
                  file=sys.stderr, flush=True)
            if once:
                sys.exit(1)
        time.sleep(max(0.5, interval - (time.time() - t0)))
    inv.close()
    if client is not None:
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
